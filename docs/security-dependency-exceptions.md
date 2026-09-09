# Security dependency exceptions

Notes for HIGH/CRITICAL Dependabot items that cannot be closed with an upstream version bump.

## extract-zip (electron-app, HIGH)

- Advisories: [CVE-2026-19693](https://www.cve.org/CVERecord?id=CVE-2026-19693) / [GHSA-7pqw-9j4j-h8q3](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3), [CVE-2026-56876](https://www.cve.org/CVERecord?id=CVE-2026-56876) / [GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv)
- Upstream: unmaintained. Latest npm release is `2.0.1`; **no `first_patched_version`**.
- Why not Electron 40+: `electron@40.10.3+` switches to `@electron-internal/extract-zip`, which is ESM-only and requires Node `>=22.12.0`. CI (`.github/workflows/ci.yml`, `build-win.yml`) is Node 20, and Electron 39 still `require()`s `extract-zip`.
- Mitigation: `electron-app` overrides `extract-zip` to the local CJS fork at `electron-app/vendor/extract-zip-safe` (Seal write-through-symlink check + symlink target containment).
- Exposure: transitive **dev** dependency of `electron` used only to unpack Electron’s official zip at install time. The shipped app does not extract untrusted archives with this library.
- Exit: drop the override when Electron 39 is retired and CI can install Electron 40.10.3+ on Node 22.

## adm-zip (relay-server, HIGH)

- `0.6.0` is the Dependabot target but still HIGH (destination symlink follow). No clean patched release in the 0.5/0.6 line as of this note. Left on `^0.5.17` until a real fix exists.
