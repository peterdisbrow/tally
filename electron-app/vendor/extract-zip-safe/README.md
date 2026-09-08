# extract-zip-safe

Local CJS fork of [`extract-zip@2.0.1`](https://www.npmjs.com/package/extract-zip), published in-repo as `extract-zip@2.0.2` so Electron's `require('extract-zip')` still resolves. Used via `electron-app` `overrides`.

## Why

`extract-zip` is unmaintained. Every published version (`<=2.0.1`) is HIGH:

- [CVE-2026-19693](https://www.cve.org/CVERecord?id=CVE-2026-19693) / [GHSA-7pqw-9j4j-h8q3](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3) — write-through symlink at the final path component
- [CVE-2026-56876](https://www.cve.org/CVERecord?id=CVE-2026-56876) / [GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) — unvalidated symlink targets

There is no `first_patched_version` on npm. Electron 40.10.3+ replaces this with `@electron-internal/extract-zip`, but that package is ESM-only and requires Node `>=22.12.0`. This repo's CI and Windows build still use Node 20, and Electron 39's `install.js` `require()`s `extract-zip`.

## Mitigation

This fork applies the public Seal containment check (reject writes when the destination is already a symlink) and also rejects symlink targets that resolve outside `opts.dir`.

`extract-zip` is only pulled in as a **dev** dependency of `electron` to unpack Electron's own official zip during `npm install`. The shipped desktop app does not extract untrusted archives with this library.

Remove this override when Electron 39 is retired and CI can install Electron 40.10.3+ on Node 22.
