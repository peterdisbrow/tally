# PTZ Protocol Upgrade (February 23, 2026)

## Goal
Upgrade PTZ support from ATEM-only camera control to common network PTZ protocols so cameras can be controlled directly by IP.

## Implemented Protocols
- `onvif` (SOAP PTZ service)
- `visca-tcp` (raw VISCA over TCP)
- `visca-udp` (raw VISCA over UDP)
- `sony-visca-udp` (Sony VISCA-over-IP UDP framing)
- `auto` mode (tries ONVIF, then VISCA TCP, then VISCA UDP)

## New Runtime Components
- Added `/church-client/src/ptz.js`
  - `PTZManager` with per-camera protocol selection and fallback
  - `OnvifPtzCamera`
  - `ViscaPtzCamera`

## Commands Added / Upgraded
- Existing commands now route to network PTZ first, then ATEM fallback:
  - `ptz.pan`, `ptz.tilt`, `ptz.zoom`, `ptz.preset`
- New commands:
  - `ptz.stop`
  - `ptz.home`
  - `ptz.setPreset`

## UI / Config Changes
- Equipment tab PTZ rows now support:
  - `protocol`, `port`, `username`, `password` (plus `ip`, `name`)
- PTZ test now protocol-aware:
  - ONVIF endpoint probe
  - VISCA TCP connect probe
  - VISCA UDP datagram probe

## Research References
- ONVIF Core Spec (security, WS-Security UsernameToken digest):  
  https://www.onvif.org/specs/core/ONVIF-Core-Specification.pdf
- ONVIF PTZ Service Spec (ContinuousMove, Stop, GotoPreset, etc.):  
  https://www.onvif.org/specs/srv/ptz/ONVIF-PTZ-Service-Spec.pdf
- ONVIF Media Service Spec (profile token retrieval patterns):  
  https://www.onvif.org/specs/srv/media/ONVIF-Media-Service-Spec.pdf
- VISCA command reference examples (pan/tilt/zoom/preset semantics):  
  https://hivehelp.ptzoptics.com/support/solutions/articles/13000028426-visca-serial-control-and-command-list
- Sony VISCA over IP framing and default port reference example:  
  https://support.avonic.com/support/solutions/articles/80001153827-visca
- Protocol support matrix used for common vendor interoperability checks:  
  https://ptzoptics.com/guide-to-ptz-camera-protocols
