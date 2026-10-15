"""HTTP fault injection for the Tauri desktop app's backend calls.

Loaded by `scripts/tauri-dev-mitm.ts` into a mitmdump running in reverse-proxy
mode in front of the API bases the app was built against. Because
`src/lib/offline/connectivity.ts` hands `AUTH_BASE` to the Rust probe
(`set_connectivity_probe_url`), one listener sits in front of the SPA's fetches,
the ProjectSync WebSocket, *and* the Rust connectivity loop.

Scope: this addon handles only the faults that leave the listener **up**.
Faults that must kill connections already open -- `offline` and `flap` -- are
applied by the orchestrator stopping the listener process, because mitmproxy 12
relays reverse-proxied WebSocket connections raw (its `websocket_*` hooks never
fire) and gives an addon no way to drop an established connection. The state
file is shared; this addon simply ignores the modes it does not own.

The active fault lives in a small JSON state file (`AQUILLA_MITM_STATE`) that
`scripts/mitm-mode.ts` writes, re-read whenever its mtime changes. That
indirection is the point: you flip modes against a *running* app, which is what
testing offline->online outbox flush actually needs.

Modes handled here
------------------
blackhole  Hold the request open and never answer. The captive-portal case:
           the Rust probe gives up at its own 3s timeout, but webview `fetch`
           has no timeout and hangs indefinitely.
error      Answer with an HTTP status (default 503). Note this does NOT flip
           the connectivity chip: `check_connectivity_once` in
           `src-tauri/src/connectivity.rs` is `send().await.is_ok()`, which is
           true for any response that arrives. That divergence -- writes
           failing while the chip still reads "online" -- is the point of
           having this mode.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path

from mitmproxy import http

log = logging.getLogger("aquilla.fault")

# Modes this addon acts on. Everything else ("pass", plus the listener-level
# "offline"/"flap") means "forward normally" as far as the addon is concerned:
# when the orchestrator wants those enforced, there is no listener to reach.
ADDON_MODES = frozenset({"blackhole", "error"})
KNOWN_MODES = ADDON_MODES | {"pass", "offline", "flap"}

DEFAULT_STATE = {
    "mode": "pass",
    "status": 503,
    "stallSeconds": 600,
    "periodSeconds": 20,
}


class Fault:
    def __init__(self) -> None:
        self.path = Path(os.environ.get("AQUILLA_MITM_STATE", ".mitm-state.json"))
        self._mtime: int | None = None
        self._state: dict = dict(DEFAULT_STATE)
        self._announced: str | None = None

    def _state_now(self) -> dict:
        """Re-read the state file when it has changed on disk."""
        try:
            mtime = self.path.stat().st_mtime_ns
        except OSError:
            # No readable state file: stay in the last known mode rather than
            # snapping back to `pass`, so a transient read error cannot
            # silently heal an outage you are in the middle of observing.
            return self._state

        if mtime != self._mtime:
            self._mtime = mtime
            try:
                loaded = json.loads(self.path.read_text())
            except (OSError, ValueError) as err:
                log.warning("unreadable state file %s (%s) — keeping current mode", self.path, err)
                return self._state
            if not isinstance(loaded, dict):
                log.warning("state file %s is not an object — keeping current mode", self.path)
                return self._state
            mode = loaded.get("mode", "pass")
            if mode not in KNOWN_MODES:
                log.warning("unknown mode %r — keeping current mode", mode)
                return self._state
            self._state = {**DEFAULT_STATE, **loaded}
            if mode != self._announced:
                self._announced = mode
                log.info("fault mode -> %s", mode)

        return self._state

    async def request(self, flow: http.HTTPFlow) -> None:
        state = self._state_now()
        mode = state.get("mode", "pass")
        if mode not in ADDON_MODES:
            return

        where = f"{flow.request.method} {flow.request.path}"
        if mode == "blackhole":
            stall = float(state.get("stallSeconds", 600))
            log.info("blackhole %s (holding %.0fs)", where, stall)
            await asyncio.sleep(stall)
            # If the client is somehow still waiting, end it rather than
            # forwarding a request whose fault window has long expired.
            flow.kill()
        elif mode == "error":
            status = int(state.get("status", 503))
            log.info("error %d %s", status, where)
            flow.response = http.Response.make(
                status,
                b"aquilla mitm fault injection",
                {"Content-Type": "text/plain"},
            )


addons = [Fault()]
