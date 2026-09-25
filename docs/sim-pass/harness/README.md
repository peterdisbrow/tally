# Booth lab harness (copied from the Linux lab box)

These scripts ran the Linux booth lab that produced `docs/sim-pass/SIM-PASS-REPORT.md`. They lived
outside the repo at `/workspace/tally-linux` and were copied here as-is for the handoff. **The paths in
them are hard-coded**: repo at `/workspace/tally`, lab root at `/workspace/tally-linux`. The quickest
way to run them unchanged:

```bash
# repo checked out (or symlinked) at /workspace/tally
cp -r /workspace/tally/docs/sim-pass/harness /workspace/tally-linux
mkdir -p /workspace/tally-linux/{logs,results/sim,screenshots,data}
cp /workspace/tally-linux/data/relay.env.example /workspace/tally-linux/data/relay.env   # fill in random secrets
```

Then:

1. Install deps: `npm ci` (or `npm install --include=dev`) in `church-client`, `relay-server`,
   `electron-app`. Playwright is loaded from `electron-app/node_modules/playwright`.
2. Start the local relay: `bash scripts/restart-relay.sh` (port 3400, SQLite, reads `data/relay.env`
   in a subshell so its secrets never leak into Electron).
3. Create a church account on the **local** relay (e.g. `POST /api/churches/register` with the
   `x-api-key: $ADMIN_API_KEY` header, which is what `church-client/test/helpers/relayLoop.js` does)
   and write `data/test-credentials.json` from `data/test-credentials.example.json`.
4. Start MockLab (simulated ATEM on UDP 9910, control HTTP on 9911):
   `nice -n 5 node sims/start-mocklab.js > logs/mocklab.log 2>&1 &`
5. Run a booth script, e.g. `DISPLAY=:2 NODE_ENV=development TALLY_RUN_ID=try1 node scripts/sim/booth-obs.mjs`.
   Needs an X display (Xvfb is fine). Packaged builds: set `TALLY_PACKAGED_BIN` to the extracted
   AppImage (`squashfs-root/tally-connect`) or deb (`opt/Tally/tally-connect`) binary.

What each file is:

| File | Purpose |
|---|---|
| `scripts/e2e-electron.mjs` | 9-check booth e2e (sign-in, room, ATEM sim, PGM/PVW, relay drop, restart) |
| `scripts/paces-e2e.mjs` | "hard" booth checks (dead IP, rapid disconnects, relay down, kill -9, rejoin). `PACES_RELAY_MODE=stop|kill` |
| `scripts/sim/booth-*.mjs` | per-device booth e2e (OBS, X32 audio, SQ, A&H dLive/Avantis, Yamaha CL5/TF5, ProPresenter, Companion, PCO, VISCA), read passively from the screen, remote commands via the relay `/api/command {wait:true}` |
| `scripts/sim/booth-lib.mjs` | shared helpers for the booth scripts |
| `scripts/paces-suite-g6.sh` | latest milestone gate: all booths on source + AppImage + deb, then electron unit, church unit, church sim (relay loop required), relay vitest. `bash scripts/paces-suite-g6.sh A` then `B` |
| `scripts/paces-suite-*.sh` | earlier gates (g2..g5, per-device suites) |
| `scripts/sim/redproof.sh` | red proof: green run + each mock mutation mode + old Tally code via a git worktree |
| `scripts/sim/all-units.sh` | every unit suite once |
| `scripts/cleanup-tally.sh` | kills leftover Tally Electron/agent processes only |
| `scripts/restart-relay.sh` | restarts the local relay (also clears the in-memory 5/15-min login limiter) |
| `sims/start-mocklab.js` | MockLab (electron-app/src/mockLabManager) on fixed lab ports |
| `LAB-README.md` | the original lab README (build commands, launch flags) |

Never point any of this at production (`api.tallyconnect.app`, Railway, Neon). Never use ports
3000/3100/4100/4180/7880/8000/8001 on the shared box (another project lives there).
