# Network Scanning & Topology Discovery Engine

## Design Document — Shared Scanning Module for TallyConnect & Site Ops

**Author:** Andrew
**Date:** April 4, 2026
**Status:** Draft — For Review

---

## 1. Overview

This design describes a **shared, decoupled network scanning engine** that powers two products:

1. **TallyConnect** — Desktop Electron app for church AV environments. The scanning engine feeds data to the Tally Engineer AI, enabling specific, actionable AV networking recommendations.
2. **Site Ops** — SaaS dashboard for UniFi integrators (`OpenClaw/projects/new-project`). The scanning engine provides network discovery and topology mapping for UniFi device management and site health monitoring.

The core scanning engine handles protocol-agnostic network discovery (ARP, port scanning, mDNS, SNMP, LLDP/CDP). Product-specific **detection layers** sit on top: AV protocol detection for TallyConnect, UniFi device discovery for Site Ops.

**Why a shared module?** Both products need to discover devices, map topology, and understand network health. Building this once avoids duplicate engineering effort and means improvements to the core engine strengthen both products simultaneously. The detection layer architecture keeps the products decoupled — TallyConnect doesn't need to know about UniFi, and Site Ops doesn't need to know about Dante.

For TallyConnect specifically, the goal is to move Tally Engineer from generic advice ("make sure you have a dedicated VLAN") to precise, environment-aware guidance ("your Dante endpoints at 10.0.2.15 and 10.0.2.22 are on the same unmanaged Netgear switch as your lobby kiosk — move them to the managed Cisco on VLAN 20 where your other Dante traffic lives").

---

## 2. Discovery Methods

### 2.1 ARP Table Scanning

Enumerate all devices on local subnets by reading the OS ARP cache and performing ARP sweeps.

- Read the local ARP table (`arp -a` on Windows/macOS, `/proc/net/arp` on Linux)
- Perform ARP sweep across all detected local subnets (e.g., send ICMP echo or ARP requests to every address in the subnet)
- Collect IP address, MAC address, and hostname for each responding device
- Resolve hostnames via reverse DNS where available
- Map MAC OUI prefixes to manufacturer names using a bundled IEEE OUI database

**Node.js approach:** Use `child_process.execFile` to call native ARP commands. For ARP sweeps, use the `raw-socket` or `net-ping` npm packages, or shell out to `nmap -sn` if installed.

### 2.2 Port Scanning (AV Protocol Detection)

Probe discovered devices for common AV protocol ports to identify their role in the AV network.

| Protocol | Ports | Detection Method |
|---|---|---|
| **NDI** | 5353 (mDNS), 5960+ (streams) | mDNS query `_ndi._tcp.local`, TCP connect on 5960-5970 |
| **Dante** | 4440 (control), 8800 (AES67), 14336-14591 (audio) | TCP connect on 4440/8800, UDP probe on 14336-14591 |
| **ATEM** | 9910 (control) | UDP probe with ATEM handshake packet |
| **OBS WebSocket** | 4455 | WebSocket upgrade attempt |
| **vMix** | 8088 (TCP API) | TCP connect, check HTTP response header |
| **ProPresenter** | 1025 (remote), varies (network) | TCP connect, ProPresenter API probe |
| **sACN (E1.31)** | 5568 (UDP) | Listen for multicast on 239.255.x.x, or UDP probe |
| **Art-Net** | 6454 (UDP) | Send ArtPoll packet, listen for ArtPollReply |
| **AES67 / Ravenna** | 5353 (mDNS), 9000+ | mDNS query `_ravenna._tcp.local` |
| **Generic HTTP** | 80, 443, 8080 | HTTP GET for device web UI identification |

**Node.js approach:** Use `net.Socket` for TCP connect scans, `dgram` for UDP probes. Implement protocol-specific handshake packets for ATEM, Art-Net, etc. to confirm device identity beyond just open ports.

### 2.3 mDNS / Bonjour Service Discovery

Passively and actively discover network services advertised via multicast DNS.

- Query for `_ndi._tcp.local` (NDI sources)
- Query for `_dante._tcp.local` and `_netaudio-arc._tcp.local` (Dante)
- Query for `_airplay._tcp.local` (AirPlay)
- Query for `_raop._tcp.local` (AirPlay audio)
- Query for `_http._tcp.local` (web-accessible devices)
- Query for `_ravenna._tcp.local` (AES67/Ravenna)

**Node.js approach:** Use the `multicast-dns` or `bonjour-service` npm package. Run a continuous listener and periodic active queries.

### 2.4 LLDP / CDP Neighbor Discovery

Discover physical network topology by reading Link Layer Discovery Protocol (LLDP) and Cisco Discovery Protocol (CDP) frames.

- Listen for LLDP frames on multicast address `01:80:C2:00:00:0E`
- Listen for CDP frames on multicast address `01:00:0C:CC:CC:CC`
- Extract: switch name, switch port, VLAN ID, device capabilities, management address

**Node.js approach:** Requires raw socket access (`cap` or `pcap` npm package) or admin/root privileges. On Windows, may require Npcap/WinPcap. This is an elevated-privilege feature — gate behind admin mode.

### 2.5 SNMP Polling (Managed Switches)

Query managed network switches for detailed port and VLAN information.

- **Switch port mapping:** Walk `ifTable` and `dot1dTpFdbTable` to map MAC addresses to physical switch ports
- **VLAN assignments:** Walk `dot1qVlanCurrentTable` and `dot1qVlanStaticTable`
- **Port utilization:** Read `ifInOctets` / `ifOutOctets` counters, calculate bandwidth over time
- **Spanning tree:** Walk `dot1dStpPortTable` to identify blocked ports and topology changes
- **PoE status:** Walk `pethPsePortTable` if PoE-powered AV devices are in play
- **IGMP snooping:** Walk multicast forwarding tables to understand multicast group membership

**Node.js approach:** Use `net-snmp` npm package. Support SNMPv1/v2c (community string) and SNMPv3 (user/auth/priv). User provides switch IPs and credentials through the UI.

### 2.6 UPnP / SSDP Discovery

Discover UPnP-enabled devices on the network via Simple Service Discovery Protocol.

- Send M-SEARCH to `239.255.255.250:1900`
- Parse SSDP responses for device type, friendly name, manufacturer, model
- Fetch device description XML for detailed capabilities

**Node.js approach:** Use `dgram` to send/receive SSDP, parse XML responses with `fast-xml-parser`.

---

## 3. Data Model

### 3.1 Per-Device Record

```typescript
interface DiscoveredDevice {
  id: string;                    // Generated UUID, stable across scans
  ip: string;
  mac: string;
  hostname: string | null;
  manufacturer: string | null;   // From OUI lookup
  deviceType: DeviceType;        // 'av_source' | 'av_destination' | 'switch' | 'router' | 'computer' | 'unknown'
  avRole: AVRole | null;         // 'ndi_source' | 'dante_endpoint' | 'atem_switcher' | 'obs_instance' | etc.

  // Port scan results
  openPorts: PortResult[];
  detectedProtocols: AVProtocol[];

  // Network location
  vlan: number | null;
  subnet: string;                // e.g., "10.0.2.0/24"
  switchPort: string | null;     // e.g., "Cisco-SG350/Gi1/0/12"
  switchName: string | null;

  // Performance
  latencyMs: number | null;      // RTT from scanner host
  bandwidthEstimate: BandwidthEstimate | null;

  // Metadata
  firstSeen: Date;
  lastSeen: Date;
  scanSource: ScanSource[];      // Which discovery methods found this device
}

interface PortResult {
  port: number;
  protocol: 'tcp' | 'udp';
  state: 'open' | 'filtered' | 'closed';
  service: string | null;        // Identified service name
  banner: string | null;         // Service banner if captured
}

interface BandwidthEstimate {
  ingressBps: number;
  egressBps: number;
  measuredAt: Date;
  measurementDurationSec: number;
}
```

### 3.2 Network Topology Record

```typescript
interface NetworkTopology {
  roomId: string;
  scannedAt: Date;
  scanDurationSec: number;
  scannerHost: DiscoveredDevice;

  devices: DiscoveredDevice[];

  vlans: VLANInfo[];
  subnets: SubnetInfo[];
  switches: SwitchInfo[];

  multicastGroups: MulticastGroup[];

  links: TopologyLink[];          // Device-to-device or device-to-switch-port connections

  issues: DetectedIssue[];        // Problems found during scan
}

interface VLANInfo {
  id: number;
  name: string | null;
  subnet: string | null;
  deviceCount: number;
  purpose: 'av_dedicated' | 'general' | 'management' | 'unknown';
}

interface SwitchInfo {
  device: DiscoveredDevice;
  isManaged: boolean;
  model: string | null;
  portCount: number;
  connectedDevices: { port: string; device: DiscoveredDevice }[];
  spanningTreeRole: string | null;
  igmpSnoopingEnabled: boolean | null;
}

interface MulticastGroup {
  address: string;
  protocol: AVProtocol;
  members: DiscoveredDevice[];
  estimatedBandwidthBps: number;
}

interface DetectedIssue {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  title: string;
  description: string;
  affectedDevices: string[];      // Device IDs
  recommendation: string;
}
```

### 3.3 Data to Collect Summary

| Data Point | Source(s) | Priority |
|---|---|---|
| Device IP, MAC, hostname | ARP, mDNS, SNMP | P0 — Phase 1 |
| Manufacturer (OUI lookup) | MAC address database | P0 — Phase 1 |
| Open AV-related ports | Port scan | P0 — Phase 1 |
| Detected AV protocols | Port scan + protocol probes | P0 — Phase 1 |
| mDNS service advertisements | mDNS listener | P0 — Phase 1 |
| Switch port assignments | SNMP | P1 — Phase 2 |
| VLAN configuration | SNMP | P1 — Phase 2 |
| LLDP/CDP neighbor info | Raw socket capture | P1 — Phase 2 |
| Network hops / latency | Traceroute + ICMP | P1 — Phase 2 |
| Multicast group memberships | IGMP snooping tables via SNMP | P2 — Phase 3 |
| Bandwidth utilization | SNMP counters over time | P2 — Phase 3 |
| PoE status | SNMP pethPsePortTable | P2 — Phase 3 |

---

## 4. AI Analysis Capabilities

When a user asks Tally Engineer a network-related question, the AI receives the latest scan results as context. This enables the following analysis categories.

### 4.1 Topology Visualization

Generate a network topology map showing device placement across VLANs and subnets. Render as an interactive diagram in the portal, or as a structured text summary in chat.

**Example AI output:**
> "Your AV network has 23 devices across 3 subnets. VLAN 10 (10.0.1.0/24) has your control devices — 2 ATEM switchers, 1 OBS instance, and the ProPresenter machine. VLAN 20 (10.0.2.0/24) is your Dante audio network with 8 endpoints. VLAN 1 (192.168.1.0/24, default) has 12 devices including 3 NDI sources that should probably be moved."

### 4.2 VLAN Hygiene

Identify AV devices sitting on non-dedicated VLANs or the default VLAN.

**Checks:**
- AV devices on the default VLAN (VLAN 1)
- AV devices sharing a VLAN with general-purpose traffic (printers, laptops, guest WiFi)
- Dante devices not on a dedicated Dante VLAN
- NDI sources on congested subnets

### 4.3 Switch Quality Assessment

Flag consumer-grade or unmanaged switches in the AV signal path.

**Checks:**
- Devices identified as unmanaged switches (OUI lookup + no SNMP response + multiple MACs behind one port)
- Consumer brands in AV paths (certain Netgear, TP-Link, Linksys consumer lines)
- Switches without IGMP snooping enabled (multicast flooding risk)
- Switches without QoS/DSCP support

### 4.4 IP and Subnet Validation

Detect configuration errors.

**Checks:**
- Duplicate IP addresses (multiple MACs for one IP)
- Devices with APIPA addresses (169.254.x.x) indicating DHCP failure
- Subnet mask mismatches (devices on same physical segment with different subnets)
- Gateway reachability issues

### 4.5 QoS / DSCP Recommendations

Based on detected protocols, recommend specific QoS configuration.

| Protocol | Recommended DSCP | Queue Priority | Notes |
|---|---|---|---|
| Dante | EF (46) | Strict priority | Clock sync packets need <1ms jitter |
| AES67 | EF (46) | Strict priority | PTP clock on CS7 (56) |
| NDI | AF41 (34) | High | Adaptive bitrate helps, but still benefits from priority |
| sACN / Art-Net | AF31 (26) | Medium-high | Lighting control, tolerates some jitter |
| ATEM control | AF21 (18) | Medium | Control plane, low bandwidth |
| General AV control | CS3 (24) | Medium | ProPresenter, vMix API, OBS WebSocket |

### 4.6 Bandwidth Analysis

Estimate bandwidth requirements vs. available capacity.

**Per-protocol estimates:**
- Dante: ~6 Mbps per stereo channel (48kHz/24bit), up to ~50 Mbps for 64-channel flows
- NDI: 100-250 Mbps per 1080p stream (NDI|HX: 10-20 Mbps)
- sACN: <1 Mbps per universe
- ATEM control: <1 Mbps
- NDI|HX2/3: 20-80 Mbps per stream depending on resolution

**AI output example:**
> "Your Cisco SG350 uplink on port Gi1/0/24 is a 1 Gbps link carrying 3 full NDI streams (~600 Mbps) plus 32 channels of Dante (~25 Mbps). You're at ~63% utilization with no headroom for a 4th NDI stream. Consider upgrading to a 10G uplink or switching 2 sources to NDI|HX3."

### 4.7 Redundancy Assessment

Identify single points of failure.

**Checks:**
- Single uplink between AV VLANs
- No redundant path for Dante primary/secondary
- All AV traffic through one switch (no stacking or LAG)
- Single DHCP server for AV subnets

### 4.8 Multicast Health

Flag potential multicast issues.

**Checks:**
- Multicast flooding on VLANs without IGMP snooping
- Excessive multicast group count (NDI discovery spam)
- Multicast crossing VLAN boundaries unintentionally
- mDNS/Bonjour gateway needs for cross-subnet NDI discovery

---

## 5. Architecture

### 5.1 Shared Module Design

The scanning engine is architected as a **decoupled, reusable Node.js module** (`@openclaw/network-scanner`) that both TallyConnect and Site Ops consume. The core handles protocol-agnostic discovery; product-specific detection layers are registered as plugins.

```
┌─────────────────────────────────────────────────────────────────────┐
│                    @openclaw/network-scanner (shared module)         │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  Core Engine                                                 │   │
│  │  ├─ ARPScanner          (device discovery)                   │   │
│  │  ├─ PortScanner         (TCP/UDP connect probes)             │   │
│  │  ├─ MDNSDiscovery       (multicast DNS service browsing)     │   │
│  │  ├─ SNMPPoller          (managed switch interrogation)       │   │
│  │  ├─ LLDPListener        (physical topology via raw frames)   │   │
│  │  ├─ SSDPDiscovery       (UPnP device discovery)              │   │
│  │  ├─ DeviceMerger        (dedup by MAC, correlate sources)    │   │
│  │  ├─ TopologyBuilder     (assemble network graph)             │   │
│  │  └─ OUILookup           (manufacturer identification)        │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              ▲                                      │
│                    Detection Layer Plugin API                        │
│                     ┌────────┴────────┐                             │
│                     │                 │                              │
│  ┌──────────────────▼──┐  ┌──────────▼──────────────────┐          │
│  │  AV Detection Layer │  │  UniFi Detection Layer       │          │
│  │  (TallyConnect)     │  │  (Site Ops)                  │          │
│  │                     │  │                               │          │
│  │  ├─ NDI prober      │  │  ├─ UniFi Inform detector    │          │
│  │  ├─ Dante prober    │  │  ├─ UniFi device classifier  │          │
│  │  ├─ ATEM prober     │  │  ├─ Adoption status checker  │          │
│  │  ├─ OBS WS prober   │  │  ├─ Firmware version checker │          │
│  │  ├─ vMix prober     │  │  ├─ USG/UDM gateway prober   │          │
│  │  ├─ ProPresenter     │  │  ├─ UniFi Switch port mapper │          │
│  │  ├─ sACN prober     │  │  └─ UniFi AP client counter  │          │
│  │  ├─ Art-Net prober  │  │                               │          │
│  │  └─ AES67 prober    │  │                               │          │
│  └─────────────────────┘  └───────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────┘
```

**Detection Layer Plugin API:**

```typescript
interface DetectionLayer {
  name: string;                    // e.g., 'av-protocols' or 'unifi'

  // Ports this layer wants scanned (merged into the core port list)
  getTargetPorts(): PortSpec[];

  // mDNS service types this layer wants discovered
  getMDNSServices(): string[];

  // Called after core discovery — classify/enrich devices
  classifyDevices(devices: DiscoveredDevice[]): Promise<DiscoveredDevice[]>;

  // Protocol-specific probes to run against devices with matching open ports
  getProbers(): ProtocolProber[];

  // Issue detection rules specific to this domain
  getIssueDetectors(): IssueDetector[];
}
```

### 5.2 Product Integration Patterns

#### TallyConnect (Electron Desktop App)

```
┌─────────────────────────────────────────────────────┐
│                  TallyConnect Electron App            │
│                                                      │
│  ┌──────────────┐    ┌───────────────────────────┐  │
│  │  Renderer     │    │  Main Process              │  │
│  │  (React UI)   │    │                            │  │
│  │               │◄──►│  ┌──────────────────────┐  │  │
│  │  - Scan       │IPC │  │  @openclaw/            │  │  │
│  │    controls   │    │  │  network-scanner       │  │  │
│  │  - Results    │    │  │  + AV Detection Layer  │  │  │
│  │    display    │    │  └──────────┬───────────┘  │  │
│  │  - Topology   │    │             │              │  │
│  │    view       │    │  ┌──────────▼───────────┐  │  │
│  └──────────────┘    │  │  ScanResultStore      │  │  │
│                       │  │  (SQLite local DB)    │  │  │
│                       │  └──────────┬───────────┘  │  │
│                       └─────────────┼──────────────┘  │
└─────────────────────────┬───────────┘                 │
                          │ HTTPS
                          ▼
                 ┌─────────────────┐     ┌─────────────────┐
                 │  Relay Server   │────►│  Tally Engineer │
                 │  (per-room)     │     │  AI (context)   │
                 └─────────────────┘     └─────────────────┘
```

The scanner runs in Electron's main process (Node.js, full network access). Results are stored locally in SQLite and synced to the relay server per-room. Tally Engineer AI receives scan data as context when answering network questions.

#### Site Ops (SaaS Dashboard)

```
┌──────────────────────────────────────────────────────┐
│              Site Ops Agent (on-prem)                  │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │  @openclaw/network-scanner                       │ │
│  │  + UniFi Detection Layer                         │ │
│  └──────────────────┬──────────────────────────────┘ │
│                     │                                 │
│  ┌──────────────────▼──────────────────────────────┐ │
│  │  ScanResultStore (SQLite local)                  │ │
│  └──────────────────┬──────────────────────────────┘ │
└─────────────────────┼────────────────────────────────┘
                      │ HTTPS (API sync)
                      ▼
             ┌─────────────────┐     ┌──────────────────┐
             │  Site Ops API   │────►│  Site Ops Portal  │
             │  (cloud)        │     │  (dashboard)      │
             └─────────────────┘     └──────────────────┘
```

Site Ops deploys a lightweight **on-prem agent** (Node.js process or Docker container) at each client site. The agent runs the shared scanner with the UniFi detection layer, syncing results to the Site Ops cloud API. The portal renders topology, device health, and alerts for the integrator.

**Key differences from TallyConnect integration:**
- No Electron — agent runs as a headless Node.js service or Docker container
- UniFi detection layer instead of AV detection layer
- Syncs to Site Ops API instead of TallyConnect relay
- Can also query UniFi Controller API directly for richer device data
- Multi-site: one agent per site, all reporting to the same integrator dashboard

### 5.3 Scanner Execution Model

The core scanner orchestration is identical regardless of which product consumes it. The detection layer plugins are registered at initialization.

**Scan orchestration:**

```typescript
import { NetworkScanner, ScanConfig } from '@openclaw/network-scanner';
import { AVDetectionLayer } from '@openclaw/network-scanner/layers/av';
// or: import { UniFiDetectionLayer } from '@openclaw/network-scanner/layers/unifi';

const scanner = new NetworkScanner({
  layers: [new AVDetectionLayer()],  // TallyConnect
  // layers: [new UniFiDetectionLayer()],  // Site Ops
  store: new SQLiteStore('./scan.db'),
});

class NetworkScanner {
  private scanners: Scanner[];
  private store: ScanResultStore;
  private config: ScanConfig;
  private layers: DetectionLayer[];

  async runFullScan(): Promise<NetworkTopology> {
    // Collect port/service targets from all registered layers
    const targetPorts = this.mergePortSpecs(
      this.config.basePorts,
      ...this.layers.map(l => l.getTargetPorts())
    );
    const mdnsServices = this.layers.flatMap(l => l.getMDNSServices());

    // Phase 1: Device discovery (parallel)
    const [arpDevices, mdnsDevices, ssdpDevices] = await Promise.all([
      this.arpScanner.scan(this.config.subnets),
      this.mdnsDiscovery.scan(mdnsServices),
      this.ssdpDiscovery.scan(),
    ]);

    // Merge and deduplicate by MAC address
    let devices = this.mergeDevices(arpDevices, mdnsDevices, ssdpDevices);

    // Phase 2: Port scan (throttled parallel)
    devices = await pMap(devices,
      (device) => this.portScanner.scan(device, targetPorts),
      { concurrency: this.config.probeConcurrency }  // Default: 10
    );

    // Phase 3: Detection layer classification and probing
    for (const layer of this.layers) {
      devices = await layer.classifyDevices(devices);
      for (const prober of layer.getProbers()) {
        devices = await prober.probe(devices);
      }
    }

    // Phase 4: Switch interrogation (if SNMP configured)
    let switchData = null;
    if (this.config.snmpTargets.length > 0) {
      switchData = await this.snmpPoller.pollAll(this.config.snmpTargets);
    }

    // Phase 5: Build topology
    const topology = this.buildTopology(devices, switchData);

    // Phase 6: Run issue detection (core + layer-specific)
    const issueDetectors = [
      ...this.coreIssueDetectors,
      ...this.layers.flatMap(l => l.getIssueDetectors()),
    ];
    topology.issues = this.runIssueDetection(topology, issueDetectors);

    // Store locally
    await this.store.saveScan(topology);

    return topology;
  }
}
```

**Note:** The sync step (relay for TallyConnect, API for Site Ops) is handled by the consuming application, not the core module. The scanner returns a `NetworkTopology` object; the application decides where to send it.

### 5.4 Package Structure

```
@openclaw/network-scanner/
├── src/
│   ├── core/
│   │   ├── arp-scanner.ts
│   │   ├── port-scanner.ts
│   │   ├── mdns-discovery.ts
│   │   ├── snmp-poller.ts
│   │   ├── lldp-listener.ts
│   │   ├── ssdp-discovery.ts
│   │   ├── oui-lookup.ts
│   │   ├── device-merger.ts
│   │   ├── topology-builder.ts
│   │   └── issue-detector.ts
│   ├── layers/
│   │   ├── av/                      # TallyConnect AV protocol detection
│   │   │   ├── index.ts
│   │   │   ├── probers/
│   │   │   │   ├── ndi.ts
│   │   │   │   ├── dante.ts
│   │   │   │   ├── atem.ts
│   │   │   │   ├── obs-websocket.ts
│   │   │   │   ├── vmix.ts
│   │   │   │   ├── propresenter.ts
│   │   │   │   ├── sacn.ts
│   │   │   │   ├── artnet.ts
│   │   │   │   └── aes67.ts
│   │   │   └── issues/
│   │   │       ├── vlan-hygiene.ts
│   │   │       ├── qos-recommendations.ts
│   │   │       ├── multicast-health.ts
│   │   │       └── bandwidth-analysis.ts
│   │   └── unifi/                   # Site Ops UniFi device detection
│   │       ├── index.ts
│   │       ├── probers/
│   │       │   ├── inform-detector.ts
│   │       │   ├── device-classifier.ts
│   │       │   ├── adoption-status.ts
│   │       │   ├── firmware-checker.ts
│   │       │   └── controller-api.ts
│   │       └── issues/
│   │           ├── firmware-outdated.ts
│   │           ├── orphaned-devices.ts
│   │           ├── channel-congestion.ts
│   │           └── uplink-health.ts
│   ├── store/
│   │   ├── sqlite-store.ts
│   │   └── memory-store.ts          # For testing
│   ├── types.ts
│   └── index.ts
├── data/
│   └── oui.json                     # IEEE OUI database (~2MB)
├── package.json
└── tsconfig.json
```

### 5.5 Local Storage

Scan results are stored in a local SQLite database (via `better-sqlite3`). The store implementation is part of the shared module.

**Tables:**
- `scans` — Scan metadata (timestamp, duration, context ID)
- `devices` — Discovered device records (keyed by MAC, updated each scan)
- `port_results` — Per-device port scan results
- `switch_ports` — SNMP-derived switch port mappings
- `vlans` — VLAN configuration data
- `topology_links` — Device-to-device connections
- `issues` — Detected issues per scan
- `scan_history` — Historical bandwidth/utilization data for trend analysis

The `context ID` is product-specific: a room ID for TallyConnect, a site ID for Site Ops.

### 5.6 Sync Layer (Product-Specific)

Sync is NOT part of the shared module — each product handles its own data transport.

**TallyConnect:** Scan results synced to the relay server per-room, making them available to Tally Engineer AI. Sync occurs after each completed scan. Only the latest full topology is synced. Data is serialized as JSON, compressed with gzip, transmitted over HTTPS.

**Site Ops:** Agent syncs to the Site Ops cloud API per-site. Supports both push (after scan) and pull (API queries the agent). Historical data is synced for trend dashboards. Multi-site aggregation happens in the cloud.

### 5.7 Scan Scheduling

| Scan Type | Default Interval | Configurable | Scope |
|---|---|---|---|
| Quick scan (ARP + mDNS only) | Every 5 minutes | Yes (1-60 min) | Device presence |
| Standard scan (ARP + mDNS + port scan) | Every 30 minutes | Yes (5-360 min) | Device identification |
| Full scan (all methods including SNMP) | Manual trigger | Can enable auto (hourly+) | Complete topology |
| Bandwidth monitoring | Continuous (when enabled) | Yes | SNMP counter polling |

### 5.8 UI Integration (TallyConnect)

The Electron renderer process provides:

- **Scan controls:** Start/stop scans, configure intervals, add SNMP targets
- **Device list:** Sortable/filterable table of all discovered devices with protocol icons
- **Topology view:** Visual network map (rendered with D3.js or similar)
- **Issue panel:** List of detected issues with severity indicators
- **Export:** Export scan results as JSON for support/debugging

Communication between renderer and main process via Electron IPC:

```typescript
// Renderer → Main
ipcRenderer.invoke('network:startFullScan');
ipcRenderer.invoke('network:getLatestTopology');
ipcRenderer.invoke('network:updateConfig', config);

// Main → Renderer
mainWindow.webContents.send('network:scanProgress', { phase, percent });
mainWindow.webContents.send('network:scanComplete', topology);
mainWindow.webContents.send('network:deviceDiscovered', device);
```

### 5.9 Site Ops Integration Details

The Site Ops agent consumes the shared scanner with the UniFi detection layer.

**UniFi-specific discovery:**
- Detect UniFi devices via Inform protocol (port 8080) and SSH fingerprinting
- Classify by type: UAP (access point), USW (switch), USG/UDM (gateway), UNVR (NVR), UCK (Cloud Key)
- Check adoption status: adopted, pending adoption, orphaned
- Query UniFi Controller API (if credentials provided) for rich device metadata
- Firmware version checking against latest stable releases

**UniFi-specific issue detection:**
- Outdated firmware across device fleet
- Orphaned / unadopted devices
- WiFi channel congestion and interference
- Uplink failures or degraded throughput
- PoE budget exceeded on switches
- Mismatched site configurations across multi-site deployments

**Site Ops agent deployment options:**
- Docker container (`docker run openclaw/siteops-agent`)
- Standalone Node.js process (installed via npm)
- Bundled with UniFi Controller on Cloud Key (future)

The agent runs headless with configuration via environment variables or a config file. A lightweight web UI on `localhost:8888` provides local status and troubleshooting.

---

## 6. Security Considerations

### 6.1 Opt-In Scanning

Network scanning must be explicitly enabled by the user.

- First-run dialog explaining what the scanner does, what data it collects, and where it's sent
- Scanning is OFF by default — user must actively enable it
- Clear toggle in settings to disable scanning at any time
- Separate opt-in for SNMP polling (requires entering credentials)

### 6.2 Credential Storage

SNMP community strings and SNMPv3 credentials are sensitive.

- Store encrypted at rest using Electron's `safeStorage` API (OS keychain integration)
- Never include credentials in scan results synced to relay
- Never log credentials in plain text
- Memory-clear credentials after use where practical

### 6.3 Data Sensitivity

Scan results contain detailed network topology — treat as sensitive.

- Scan data synced to relay is associated only with the room ID, authenticated via existing TallyConnect auth
- Relay API requires valid room authentication to access scan data
- Scan data is not exposed in the public portal — only accessible to authenticated room admins and the AI context
- Local SQLite database inherits OS file permissions (user-only access)
- Option to exclude scan data from relay sync entirely (local-only mode)

### 6.4 Scan Rate Limiting

Aggressive scanning can trigger intrusion detection systems or cause network issues.

- Default port scan concurrency: 10 simultaneous connections
- Default inter-probe delay: 50ms
- SNMP polling interval minimum: 30 seconds between full walks
- ARP sweep rate: no more than 100 requests/second
- Configurable "gentle mode" for sensitive environments (halves all rates)
- Automatic backoff if scan errors exceed threshold (potential IDS trigger)

### 6.5 Privilege Management

Some features require elevated privileges.

| Feature | Privilege Required | Handling |
|---|---|---|
| ARP table read | Standard user | Works out of the box |
| TCP port scan | Standard user | Works out of the box |
| UDP probes | Standard user (most OSes) | Works out of the box |
| LLDP/CDP capture | Raw sockets (admin/root) | Gate behind "Advanced" toggle, prompt for elevation |
| SNMP polling | Standard user | Works out of the box (network access only) |
| ICMP ping | May require admin on some systems | Fall back to TCP connect if unavailable |

---

## 7. Implementation Phases

### Phase 0: Shared Module Scaffolding

**Target: 1-2 weeks**

**Scope:**
- Set up `@openclaw/network-scanner` as a standalone npm package (monorepo or separate repo)
- Define the `DetectionLayer` plugin interface and core types (`DiscoveredDevice`, `NetworkTopology`, etc.)
- Implement the `ScanResultStore` abstraction (SQLite + in-memory for tests)
- Set up CI pipeline: lint, test, build for the shared module
- Create skeleton detection layers for AV and UniFi (interfaces only, no probers yet)
- Establish versioning strategy (semver, published to private npm registry or GitHub Packages)

**Why this phase matters:** Getting the module boundary right early prevents tight coupling. Both TallyConnect and Site Ops teams can begin integration immediately, even before the core scanners are fully built.

### Phase 1: Core Discovery Engine (MVP)

**Target: 4-6 weeks**

**Scope (shared module):**
- ARP table scanning and ARP sweep for device discovery
- TCP/UDP port scanning (configurable port lists from detection layers)
- mDNS/Bonjour service discovery (service types from detection layers)
- OUI manufacturer lookup (bundled database)
- UPnP/SSDP device discovery
- Device merge/dedup engine
- Local SQLite storage for scan results

**Scope (TallyConnect — AV detection layer):**
- Protocol-specific probes for NDI, Dante, ATEM, Art-Net, OBS WebSocket, vMix, ProPresenter, sACN, AES67
- Basic scan results UI in Electron (device list with protocol badges)
- Relay sync of scan results
- AI integration: Tally Engineer receives scan data as context for network questions

**Scope (Site Ops — UniFi detection layer):**
- UniFi Inform protocol detection (port 8080)
- Basic UniFi device classification (AP, switch, gateway)
- Headless agent scaffold with API sync
- Site Ops dashboard: device inventory view

**Key dependencies:**
- `net-ping` or native ARP commands
- `multicast-dns` npm package
- `better-sqlite3` for local storage
- OUI database (downloadable from IEEE, ~2MB)

**AI capabilities unlocked (TallyConnect):**
- "What AV devices are on my network?"
- "Is my Dante gear on a separate VLAN?" (subnet-based inference only)
- "Do I have any IP conflicts?"
- Basic protocol-aware recommendations

### Phase 2: SNMP + Physical Topology

**Target: 4-6 weeks after Phase 1**

**Scope (shared module):**
- SNMP v1/v2c/v3 polling for managed switches
- Switch port mapping (which device is on which port)
- VLAN discovery and assignment mapping
- LLDP/CDP listener (admin mode)
- Latency measurement between discovered devices
- Enhanced topology data model with switch-port-level detail

**Scope (TallyConnect):**
- Credential management UI with encrypted storage (Electron `safeStorage`)
- Switch configuration recommendations in AI output

**Scope (Site Ops):**
- UniFi Controller API integration (rich device metadata, client lists, WiFi analytics)
- Firmware version checking against latest stable releases
- Adoption status monitoring
- PoE budget tracking per switch
- Site Ops dashboard: switch port map view

**Key dependencies:**
- `net-snmp` npm package
- `pcap` or `cap` npm package (for LLDP/CDP, optional)
- Npcap on Windows (optional, for raw socket features)

**AI capabilities unlocked (TallyConnect):**
- "Show me which devices are on which switch ports"
- "Are my Dante devices on a dedicated VLAN?"
- "Is IGMP snooping enabled on my AV switch?"
- Switch-specific configuration recommendations

### Phase 3: Continuous Monitoring + Bandwidth

**Target: 4-6 weeks after Phase 2**

**Scope (shared module):**
- Continuous SNMP counter polling for bandwidth utilization
- Per-port traffic measurement over time
- Multicast group membership tracking (IGMP snooping tables)
- Historical trend storage and analysis
- Alert threshold engine (configurable per product)

**Scope (TallyConnect):**
- Bandwidth estimation based on detected AV streams
- Per-port traffic graphing in Electron UI
- Alert thresholds tuned for AV (e.g., "uplink utilization > 80%")
- Background service mode (scan continues when app is minimized)

**Scope (Site Ops):**
- WiFi channel utilization and interference monitoring
- Client connection quality tracking
- Uplink health and failover monitoring
- Site Ops dashboard: real-time bandwidth graphs, alert feed
- Multi-site comparative analytics

**Key dependencies:**
- Time-series data handling (SQLite with aggregation or embedded time-series DB)
- Background task scheduling (Electron for TallyConnect, Node.js scheduler for Site Ops agent)

**AI capabilities unlocked (TallyConnect):**
- "Do I have enough bandwidth for another NDI stream?"
- "Which port is my bottleneck?"
- "Show me traffic patterns during last Sunday's service"
- Proactive alerts: "Your uplink hit 85% utilization during the 11am service"

### Phase 4: AI-Powered Topology Visualization

**Target: 4-6 weeks after Phase 3**

**Scope (shared — visualization components):**
- Reusable topology rendering library (D3.js or Cytoscape.js)
- Auto-layout algorithm for clean visualization (hierarchical by VLAN/subnet)
- Device icons by type (extensible icon set per product)
- Color coding by VLAN, protocol, or issue severity
- Click-through to device detail
- Export topology as PDF or image

**Scope (TallyConnect):**
- Interactive network topology in the TallyConnect portal
- AV-specific device icons (camera, mixer, speaker, lighting console)
- AI-generated topology summaries and narratives
- "What-if" mode: AI suggests topology changes and shows the proposed layout
- Printable network documentation for the church tech team

**Scope (Site Ops):**
- Interactive topology in the Site Ops dashboard
- UniFi-specific device icons (AP, switch, gateway, NVR)
- Multi-site topology comparison views
- Client heatmaps overlaid on topology
- Exportable site documentation for handoff to clients

**Key dependencies:**
- D3.js or Cytoscape.js for graph rendering
- Portal frontend integration (both products)
- PDF/image export library

---

## 8. Node.js Package Dependencies

| Package | Purpose | Phase |
|---|---|---|
| `net-ping` | ICMP ping for host discovery | 1 |
| `multicast-dns` | mDNS/Bonjour service discovery | 1 |
| `better-sqlite3` | Local scan result storage | 1 |
| `p-map` | Throttled parallel async operations | 1 |
| `oui` or bundled DB | MAC OUI manufacturer lookup | 1 |
| `net-snmp` | SNMP v1/v2c/v3 polling | 2 |
| `pcap` / `cap` | Raw packet capture (LLDP/CDP) | 2 |
| `d3` / `cytoscape` | Topology visualization | 4 |

All packages should be evaluated for maintenance status, security advisories, and native compilation requirements (important for Electron cross-platform builds and Site Ops Docker images).

---

## 9. Testing Strategy

### Unit Tests (shared module)
- OUI lookup accuracy
- Device merge/dedup logic
- Detection layer plugin registration and port aggregation
- Issue detection rules (mock topology → expected issues)
- SNMP OID parsing
- Protocol probe packet construction (AV and UniFi layers)

### Integration Tests
- Scan a known test network (lab environment with known devices)
- SNMP polling against a test switch
- mDNS discovery in a controlled environment
- Relay sync round-trip (TallyConnect)
- API sync round-trip (Site Ops)
- Detection layer isolation: verify AV layer doesn't affect UniFi results and vice versa

### Field Testing
- **TallyConnect:** Deploy to 3-5 beta churches with varied network setups
- **Site Ops:** Deploy agent to 3-5 beta UniFi sites with varied device counts
- Collect anonymized scan results for AI training data
- Gather feedback on scan accuracy and recommendation quality
- Test on networks with IDS/IPS to validate rate limiting

---

## 10. Open Questions

1. **Nmap dependency:** Should we bundle a lightweight Nmap binary for more thorough scanning, or keep everything in pure Node.js? Bundling Nmap adds complexity but significantly improves scan accuracy and speed. This affects both products — if bundled, the Site Ops Docker image needs it too.

2. **Cross-platform raw sockets:** LLDP/CDP capture requires raw sockets. On Windows (TallyConnect) this means Npcap. The Site Ops Docker agent can use `cap` directly. Is the admin-mode UX overhead in Electron worth the topology data, or should we rely on SNMP for physical topology in TallyConnect and reserve raw sockets for the Site Ops agent?

3. **Scan data retention:** How long should we keep historical scan data locally? Indefinitely (good for trend analysis) or rolling window (simpler storage management)? Site Ops likely needs longer retention than TallyConnect for SLA reporting.

4. **Multi-site churches:** For churches with multiple campuses, should scan data be segregated by site/room, or should the AI have cross-site visibility for consistency recommendations? This parallels Site Ops' multi-site model — potential for a shared multi-site abstraction.

5. **Privacy/compliance:** Do we need explicit data processing agreements for network scan data? Churches and UniFi client sites may both have organizational data policies. Site Ops handling client network data has additional MSP/integrator liability considerations.

6. **Electron auto-updater interaction:** Will background scanning in TallyConnect interfere with Electron's auto-update process? Need to pause scans during updates.

7. **Shared module versioning:** How do we coordinate releases across the shared module and two consuming products? Breaking changes in `@openclaw/network-scanner` affect both TallyConnect and Site Ops. Consider a stability policy: core APIs are stable post-1.0, detection layer APIs can evolve faster.

8. **Monorepo vs. separate repos:** Should `@openclaw/network-scanner`, the AV layer, and the UniFi layer live in a monorepo (easier cross-cutting changes) or separate repos (cleaner boundaries, independent release cycles)?

9. **Both layers simultaneously:** Could a single deployment run both detection layers? Some churches use UniFi for their network infrastructure AND have AV gear. A combined scan could give the most complete picture. Worth supporting or an edge case?

---

## 11. Success Metrics

### TallyConnect
- **Discovery accuracy:** >95% of AV devices on the network correctly identified and classified
- **Scan completion time:** Full scan completes in <60 seconds for networks with <100 devices
- **AI recommendation quality:** >80% of network recommendations rated "helpful" or "actionable" by beta users
- **Zero network disruption:** No reports of scanning causing network issues or triggering IDS alerts at default settings
- **Adoption:** >60% of active TallyConnect desktop users enable network scanning within 3 months of release

### Site Ops
- **Discovery accuracy:** >98% of UniFi devices on the network correctly identified and classified
- **Agent reliability:** >99.5% uptime for the on-prem scanning agent
- **Sync latency:** Scan results available in the Site Ops dashboard within 30 seconds of scan completion
- **Multi-site scale:** Support 50+ sites per integrator dashboard without performance degradation
- **Integrator value:** Reduce average site visit diagnostic time by >30%

### Shared Module
- **Reuse ratio:** >80% of core scanning code shared between TallyConnect and Site Ops (measured by lines of code)
- **Independent deployability:** Each product can upgrade the shared module independently without breaking the other
- **Detection layer isolation:** Zero cross-contamination between AV and UniFi detection results
