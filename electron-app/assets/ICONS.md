# Icon Assets Needed

For production builds, create these icon files:

## macOS
- `icon.icns` — 1024x1024 app icon in Apple ICNS format
  - Generate from a 1024x1024 PNG using `iconutil` or an online converter
  - Should feature a church/broadcast icon with ATEM School branding

## Windows  
- `icon.ico` — Multi-resolution ICO file (16, 32, 48, 64, 128, 256px)

## System Tray (both platforms)
- `tray-grey.png` — 16x16 @2x (32x32) — disconnected state
- `tray-green.png` — 16x16 @2x — fully connected
- `tray-yellow.png` — 16x16 @2x — partially connected  
- `tray-red.png` — 16x16 @2x — error state

Note: Current build generates tray icons programmatically. For production, replace with proper PNG assets for crisp rendering.

## Suggested Design
- Primary color: #ef4444 (ATEM School red)
- Icon concept: church silhouette with broadcast/signal waves
- Keep it simple — needs to read at 16px in the system tray
