# Simulating network faults in the Tauri desktop app

`pnpm tauri:dev:mitm` runs the desktop app with every backend call routed
through a local [mitmproxy](https://mitmproxy.org), so you can watch the traffic
and inject network faults **against a running app** — without touching macOS
network settings, installing a CA, or restarting anything.

Built for the offline path: take the app offline, keep editing, come back
online, and watch the IndexedDB outbox flush.

```bash
brew install mitmproxy          # once
pnpm tauri:dev:mitm             # starts the proxy + the app

# then, in another terminal, against the running app:
pnpm mitm:mode offline          # the network "goes away"
pnpm mitm:mode pass             # …and comes back
```

## Modes

| Mode | What happens | Connectivity chip |
| --- | --- | --- |
| `pass` | Everything forwards untouched. The "back online" switch. | online |
| `offline` | The listener stops. Live sockets — including the sync WebSocket — drop with close code `1006`, and every new connection gets `ECONNREFUSED`. | **offline** |
| `blackhole` | Requests are held open and never answered. The captive-portal case. | **offline** (via the 3s probe timeout) |
| `error` | Requests get an HTTP status back (`--status`, default 503). | **stays online** — see below |
| `flap` | Alternates `offline`/`pass` on a timer (`--period`, default 20s). | flips |

```bash
pnpm mitm:mode error --status 429
pnpm mitm:mode blackhole --stall 30
pnpm mitm:mode flap --period 30
pnpm mitm:mode                     # print the current mode
pnpm mitm:mode --help
```

Flags persist across mode changes, so setting `--status 429` once keeps it for
later `error` runs in the same session.

### Two gotchas worth knowing

**`error` does not take the connectivity chip offline.**
`check_connectivity_once` in `src-tauri/src/connectivity.rs` is:

```rust
client.head(url).send().await.is_ok()
```

`send()` returns `Ok` for *any* response that arrives, 503 included. So `error`
mode gives you a genuinely useful divergence — writes failing while the chip
still reads "online" — but it is not the way to simulate a disconnect. Use
`offline` or `blackhole` for that. (This also means a real backend 503ing
everything currently reads as "online" in the app.)

**`blackhole` stalls HTTP only.** A sync WebSocket that is already open keeps
streaming, because mitmproxy relays reverse-proxied WebSockets raw (see below).
Use `offline` when the socket itself has to die.

## How it works

Every host the app talks to is resolved from three build-time variables —
`VITE_AUTH_BASE`, `VITE_CHAT_BASE`, `VITE_SYNC_WORKER_HOST`. The harness
resolves them with Vite's own `loadEnv` (so `.env.local` and
`.env.development.local` are honoured exactly as the app would), starts a
mitmproxy reverse-proxy listener per distinct upstream origin, and hands the
rewritten bases to the `tauri dev` child process.

```
VITE_AUTH_BASE=https://api.dev.aquilla.app/identity
                      ↓
VITE_AUTH_BASE=http://127.0.0.1:8081/identity   →   mitmproxy   →   api.dev.aquilla.app
```

Three details make this work without any system-level change:

- **The Rust side comes along for free.** `src/lib/offline/connectivity.ts`
  hands `AUTH_BASE` to `set_connectivity_probe_url`, so the Rust connectivity
  loop probes the proxy too. One listener therefore fronts the SPA's fetches,
  the ProjectSync WebSocket, *and* the online/offline chip — a fault moves all
  three together.
- **No `.env` file is written.** Vite's `loadEnv` applies `process.env` last, so
  passing the rewritten vars to the child process beats `.env.local` without
  colliding with the `.env.development.local` that `scripts/dev-stack.ts`
  manages.
- **No CA, no system proxy.** The listener speaks plain HTTP to the app and TLS
  upstream, so nothing has to trust a mitmproxy certificate. `sync-worker-url.ts`
  already downgrades a `127.0.0.1` host to `http`/`ws`, so no app code changes.

Against the local `pnpm dev` stack the three bases have *different* origins, so
the harness starts one listener per origin (8081, 8082, …) rather than assuming
they share a host.

### Why the listener is stopped instead of faulting each flow

A "disconnect" that leaves the sync WebSocket streaming is not a disconnect.
mitmproxy 12.2.3 **relays reverse-proxied WebSocket connections raw**: its
`websocket_start` / `websocket_message` hooks never fire (verified — at
`flow_detail=3` it prints the 101 handshake and no frame content), and an addon
has no API to drop an established connection (`proxyserver.active_connections`
returns a count, not handles).

So the harness splits responsibility:

- `scripts/tauri-dev-mitm.ts` owns the **listener process**. `offline` and
  `flap` stop it, which drops live sockets and refuses new connections — a
  closer model of a vanished network than any per-flow fault.
- `scripts/mitm/fault.py` owns the **listener-up faults**, `blackhole` and
  `error`, which only need to act on requests that reach it.

`scripts/lib/mitm-state.ts` holds the shared mode list, and
`scripts/lib/mitm-state.test.ts` asserts the two sides agree — a mode added to
one only would be accepted by the CLI and silently ignored by the proxy.

Coming back up means respawning mitmdump and waiting for the port, roughly one
to two seconds. Keep `flap --period` at 5s or more or the "up" phase is mostly
startup.

## CSP

The shipped CSP allows only `https:`/`wss:` for backend calls, which blocks a
plain-HTTP loopback proxy. `src-tauri/tauri.mitm.conf.json` is a dev-only
overlay adding `http://127.0.0.1:* ws://127.0.0.1:*` to `connect-src`, passed
via `tauri dev --config`. `tauri:build` never sees it, so the signed release CSP
is unaffected — and `scripts/lib/tauri-mitm-config.test.ts` pins the overlay as
a pure superset of the shipped CSP so the two cannot drift.

## Other flags

```bash
pnpm tauri:dev:mitm --port 9000    # first listener port (+1 per upstream)
pnpm tauri:dev:mitm --mode offline # start with a fault already applied
pnpm tauri:dev:mitm --no-app       # proxy only; prints the env to export
```

`--no-app` is handy for pointing the browser SPA or a manual client at the same
fault harness.

Like `pnpm tauri:dev`, this command has a `pre` hook that frees Vite's port
1420 first (`scripts/ensure-port-free.mjs`), prompting before it kills
anything. An existing `tauri dev` session on 1420 will otherwise make the
launch fail with `Port 1420 is already in use`.

## Scope

The proxy sees traffic to the API bases. It does **not** see calls that go
straight to a third party — R2, the GitHub updater endpoint, a hosted LLM
provider called directly. Those would need a system-wide proxy with a trusted
CA, which this harness deliberately avoids.
