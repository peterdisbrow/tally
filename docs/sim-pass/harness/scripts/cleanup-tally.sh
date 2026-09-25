#!/usr/bin/env bash
# Kill leftover Tally Electron / agent processes from harness runs ONLY.
# Never kills its own ancestors (the invoking shell may mention these paths).
anc=" $$ "; p=$$
while [ "$p" -gt 1 ] 2>/dev/null; do p=$(ps -o ppid= -p "$p" | tr -d ' '); [ -z "$p" ] && break; anc="$anc$p "; done
for pat in 'electron-app/node_modules/electron/dist/electron .*src/main.js' 'squashfs-root/tally-connect' 'linux-unpacked/tally-connect' 'opt/Tally/tally-connect' 'church-client/src/index.js'; do
  for pid in $(pgrep -f "$pat"); do
    case "$anc" in *" $pid "*) continue;; esac
    # only kill real executables (electron/tally-connect/node), not shells mentioning the path
    comm=$(ps -o comm= -p "$pid" 2>/dev/null)
    case "$comm" in bash|sh|dash|zsh) continue;; esac
    kill "$pid" 2>/dev/null
  done
done
sleep 1
exit 0
