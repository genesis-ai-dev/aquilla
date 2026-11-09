// "This computer" workspace (desktop only). Proves the IPC wiring the page
// depends on, not the React logic (vitest covers that): linked folders persist
// through the real app-data roots file across `paratext_add_root` /
// `paratext_user_roots` / `paratext_remove_root`, the prep step gates the first
// scan, and the scan runs end to end against this machine's Paratext locations.
// Same `window.__TAURI__.core.invoke` approach as smoke.spec.ts (see its header).
import { browser, expect } from "@wdio/globals"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

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

/** Client-side route change: BrowserRouter listens to popstate. */
async function goTo(pathname: string) {
  await browser.execute((p) => {
    window.history.pushState({}, "", p)
    window.dispatchEvent(new PopStateEvent("popstate"))
  }, pathname)
}

const exists = (selector: string) => browser.execute((s) => document.querySelector(s) !== null, selector)

describe("This computer workspace", () => {
  it("persists a linked folder in the app-data roots file, without scanning it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aq-this-computer-"))
    try {
      const before = await invoke<string[]>("paratext_user_roots")
      expect(before).not.toContain(dir)

      await invoke("paratext_add_root", { path: dir })
      const after = await invoke<string[]>("paratext_user_roots")
      expect(after).toContain(dir)

      await invoke("paratext_remove_root", { path: dir })
      const removed = await invoke<string[]>("paratext_user_roots")
      expect(removed).not.toContain(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it("shows the permission prep step first, then scans on request and remembers it", async () => {
    await browser.execute(() => localStorage.removeItem("aq.paratext-scan.v1"))
    await goTo("/this-computer")

    await browser.waitUntil(() => exists('[data-testid="paratext-scan-prep"]'), { timeout: 15_000 })
    expect(await exists('[data-testid="paratext-scan-results"]')).toBe(false)

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="paratext-scan-prep"] button')?.click()
    })
    await browser.waitUntil(() => exists('[data-testid="paratext-scan-results"]'), { timeout: 30_000 })

    const names = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-testid="paratext-found-project"]')).map((el) => el.textContent ?? ""),
    )
    // Evidence for the run log: which projects this machine's scan found.
    console.log(`[this-computer] paratext projects found: ${names.length}`, names)

    expect(await browser.execute(() => localStorage.getItem("aq.paratext-scan.v1"))).toBe("ok")
  })
})
