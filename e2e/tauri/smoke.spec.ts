// Tauri desktop-shell smoke suite — see docs/superpowers/plans/2026-04-30-e2e-framework-and-smoke.md
// ("Plan 3") and AGENTS.md. Runs only as a release gate (tauri-release.yml), against a debug
// binary built with `pnpm run tauri:build:e2e` (the `e2e-webdriver` Cargo feature enables the
// embedded WebDriver server + the test-only `simulate_deep_link_callback` command — see
// src-tauri/src/lib.rs / auth.rs). Deliberately small and native-surface-only: app/editor logic
// is already covered by the Playwright web smoke suite against the same React code this WebView
// renders. Each case here proves the Rust <-> JS IPC wiring for one native surface, not the pure
// Rust logic underneath it (that's src-tauri's own `cargo test` unit suite).
//
// Uses plain WebdriverIO `browser.execute()` against `window.__TAURI__.core.invoke` directly,
// NOT `@wdio/tauri-service`'s own `browser.tauri.execute()`/`triggerDeeplink()` wrappers —
// confirmed by hand (2026-09-19, @wdio/tauri-service 1.4.0) that both depend on an internal
// mock-proxy init-script (`window.__wdio_original_core__`) that this Tauri/plugin version
// combination never actually injects into the page, making those wrappers unconditionally
// time out. `window.__TAURI__.core.invoke` itself works correctly and is confirmed to reach
// real Rust commands. Revisit dropping this workaround once a newer @wdio/tauri-service fixes
// the injection (there's no mocking need here that would require the wrapper anyway).
import { browser, expect } from "@wdio/globals"

interface TauriWindow {
  __TAURI__: { core: { invoke: (cmd: string, args?: unknown) => Promise<unknown> } }
}

async function invoke<T>(cmd: string, args?: unknown): Promise<T> {
  return browser.execute(
    (command, commandArgs) => (window as unknown as TauriWindow).__TAURI__.core.invoke(command, commandArgs),
    cmd,
    args,
  ) as Promise<T>
}

const REPO_KEY = "e2e-smoke"

describe("Tauri desktop shell", () => {
  it("boots the app window and renders the SPA root", async () => {
    const rootChildCount = await browser.execute(
      () => document.getElementById("root")?.children.length ?? 0,
    )
    expect(rootChildCount).toBeGreaterThan(0)
  })

  it("round-trips a token through the OS-keychain-backed command bridge", async () => {
    await invoke("set_token", { token: "e2e-jwt", refreshToken: "e2e-refresh" })

    const token = await invoke<string>("get_token")
    expect(token).toBe("e2e-jwt")

    await invoke("clear_token")
    const cleared = await invoke<string | null>("get_token")
    expect(cleared).toBeNull()
  })

  it("round-trips a file through the fs_bridge command surface", async () => {
    const path = "smoke.txt"
    const bytes = Array.from(Buffer.from("hello from e2e"))

    await invoke("fs_write_file", { repoKey: REPO_KEY, path, data: bytes })

    const readBack = await invoke<number[]>("fs_read_file", { repoKey: REPO_KEY, path })
    expect(readBack).toEqual(bytes)

    const stat = await invoke<{ kind: string; size: number }>("fs_stat", { repoKey: REPO_KEY, path })
    expect(stat.kind).toBe("file")
    expect(stat.size).toBe(bytes.length)

    await invoke("fs_unlink", { repoKey: REPO_KEY, path })
  })

  it("reports connectivity via the get_connectivity command", async () => {
    const online = await invoke<boolean>("get_connectivity")
    expect(typeof online).toBe("boolean")
  })

  it("wires a simulated codex:// deep-link callback into the keychain", async () => {
    // WebDriver can't trigger a real OS URL-open event, and @wdio/tauri-service's own
    // triggerDeeplink() only injects a JS-layer event this app has no listener for (see file
    // header) — so this exercises the same parse -> store -> emit wiring `handle_callback_url`
    // runs for a real deep link, via the test-only command src-tauri/src/auth.rs adds under
    // the e2e-webdriver feature.
    await invoke("clear_token")

    await invoke("simulate_deep_link_callback", {
      url: "codex://auth/callback?token=deep-link-jwt&refresh=deep-link-refresh",
    })

    const token = await invoke<string>("get_token")
    expect(token).toBe("deep-link-jwt")

    await invoke("clear_token")
  })
})
