# Hello AO Bible fixtures

Checked-in snapshots of [bible.helloao.org](https://bible.helloao.org/docs/)
`complete.json` payloads. AQU-1060's six-editor load spec imports the whole
Berean Standard Bible as the in-flight same-project write; it must read this
file, not the live API.

## `BSB.complete.json.gz`

- **Translation:** Berean Standard Bible (`BSB`)
- **Upstream:** `https://bible.helloao.org/api/BSB/complete.json`
- **Snapshotted:** 2026-08-31 (upstream `Last-Modified: 2026-08-18`)
- **Shape:** gzip of the unmodified `complete.json` bytes so
  `parseHelloaoComplete` still consumes a real producer payload.

Refresh (does not run in CI/tests):

```bash
curl -fsSL -A "AquillaE2E/1.0 (AQU-1060 fixture snapshot)" \
  "https://bible.helloao.org/api/BSB/complete.json" \
  | gzip -9 > e2e/fixtures/helloao/BSB.complete.json.gz
```
