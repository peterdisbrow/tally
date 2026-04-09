# TallyConnect Desktop App: Full Electron App vs. Tray Helper

## The Question

Should TallyConnect keep its full-window Electron desktop app, or refactor it into a lightweight tray helper (like Bitfocus Companion) that handles only the things a browser can't?

---

## Option A: Keep the Full Electron App

### Pros

**Offline resilience.** A full desktop app can function even when the relay server is unreachable. Churches with unreliable internet get a local fallback for monitoring and control. The portal dies without connectivity — the desktop app doesn't have to.

**Faster local device interaction.** Direct IPC to native modules means lower latency for time-sensitive operations like ATEM switching commands, tally updates, and HyperDeck transport control. No round-trip through a WebSocket to the relay server and back.

**No browser dependency.** You control the runtime. No Chrome version issues, no tab getting accidentally closed during a live service, no "which browser do we use" support questions. It just works.

**Richer device integration.** Electron's Node.js backend can use native modules, raw sockets, USB communication, and platform APIs that browsers will never support. Future integrations (USB HID for tally lights, serial for legacy devices) are straightforward.

**Single install, complete experience.** A new church downloads one app and has everything — monitoring, control, configuration. No "now open this URL in your browser" step. Lower friction for non-technical users.

**App store / distribution story.** A standalone app feels more like a "real product" to buyers. It's something they install, it shows up in their dock, it has an icon. This matters for perceived value, especially at the $49-149/mo price point.

### Cons

**Duplicated UI effort.** Every feature you build in the portal, you have to consider whether the desktop app also needs it. Two surfaces to design, build, test, and maintain. This is the biggest ongoing tax.

**Electron overhead.** Chromium + Node.js bundles ~150-200MB. It's a heavy install for what increasingly becomes a monitoring tool. Memory usage sits at 200-400MB even idle.

**Platform maintenance.** macOS code signing, notarization, auto-update (Squirrel/electron-updater), Windows code signing, potential Linux support. Each platform is its own release pipeline. You've already felt this pain.

**Update friction.** Desktop apps need users to update. The portal updates instantly for everyone. Stale desktop versions create support issues ("it worked yesterday" — yes, because you're on v1.1.39 and we're on v1.1.53).

**Feature drift.** The portal evolves faster because it's easier to deploy. The desktop app falls behind, creating inconsistency. Users don't know which one is "right."

---

## Option B: Tray Helper (Companion-style)

### Pros

**Razor-sharp scope.** The tray app does exactly what a browser can't: network scanning, local device connections (ATEM, HyperDeck, NDI, Dante), mDNS discovery, Shelly smart plug control, and syncing all that data to the relay server. That's it. Everything else lives in the portal.

**One UI to maintain.** All user-facing interface work goes into the portal. No duplication. Features ship once, instantly, to everyone. The portal becomes THE product; the tray app is infrastructure.

**Tiny footprint.** Without a renderer window, the app drops to ~50-80MB installed and ~30-60MB memory. It runs silently in the background. Churches don't even think about it — it's like a printer driver.

**Faster iteration.** Portal changes deploy via Railway in seconds. The tray app rarely needs updates because its scope is small and stable (network scanning doesn't change often). When it does need an update, it's a much smaller surface to test.

**Companion users already get it.** Your target market runs Companion — they understand the "tray app + browser UI" model. Zero learning curve.

**Shared module architecture.** The tray app's core (the network scanner) is the same shared `@openclaw/network-scanner` module that Site Ops will use. Building it as a focused agent instead of a full app makes the shared architecture cleaner.

**Better mobile story.** The portal works on tablets and phones. The full Electron app doesn't. By investing in the portal, you automatically improve the mobile experience too.

### Cons

**Requires internet.** The portal needs connectivity to the relay server. If a church's internet drops during a service, they lose the dashboard (though the tray app could still maintain local device connections and tally).

**Two things to install.** New users install the tray app AND bookmark/open the portal. It's an extra step, though you can mitigate this by having the tray app open the portal URL on first launch.

**Less "product" feel.** A tray icon doesn't feel like a $49/mo product the way a full desktop app does. The portal carries the product perception now — it needs to look and feel premium.

**Local-only fallback gap.** If you want to offer any monitoring when the relay server is down, you'd need a minimal local web UI served by the tray app (like Companion's localhost:8000). This adds back some UI surface area.

**Lost features without replacement.** Anything currently in the desktop app that isn't in the portal yet would need to be ported. The desktop app might have flows (like initial device setup, network configuration) that don't exist in the portal today.

---

## Recommendation: Option B — Tray Helper

The portal has reached the point where it covers 90%+ of what the desktop app's UI does, and it does it better because it's accessible from any device. The remaining 10% is exactly the stuff that requires local network access — which is exactly what the tray helper would handle.

Here's the migration path I'd suggest:

**Phase 1 — Build the tray helper alongside the existing app.** The network scanner we're building right now becomes the tray app's core feature. Ship it as a separate lightweight app: "TallyConnect Agent." It scans the network, maintains device connections, and syncs to the relay server. The portal gets a "Network" page showing discovered devices.

**Phase 2 — Port remaining desktop-only features to the portal.** Audit what the full Electron app does that the portal doesn't. Port those features. This is probably device configuration wizards, some diagnostic views, and maybe the direct ATEM/HyperDeck control panels.

**Phase 3 — Deprecate the full Electron app.** Once the portal has full parity and the tray agent handles all local operations, sunset the full desktop app. Existing users transition to the agent + portal.

**Phase 4 — Local fallback (optional).** If offline resilience matters enough, add a minimal localhost web UI to the tray agent — like Companion does at port 8000. This gives churches a degraded-but-functional local dashboard when internet is down.

The key insight: you're not removing the desktop app, you're splitting it into its two natural halves. The UI half becomes the portal (which is already better). The local-agent half becomes the tray helper (which is actually what makes TallyConnect special). Both halves get better by being focused.

This also sets up the Site Ops story perfectly — the same agent architecture works for UniFi integrators, just with different detection layers on top of the shared scanning engine.
