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

    const prep = await $('[data-testid="paratext-scan-prep"]')
    await prep.waitForExist({ timeout: 15_000 })
    await expect($('[data-testid="paratext-scan-results"]')).not.toBeExisting()

    await $('[data-testid="paratext-scan-prep"] button').click()
    const results = await $('[data-testid="paratext-scan-results"]')
    await results.waitForExist({ timeout: 30_000 })

    const found = await $$('[data-testid="paratext-found-project"]')
    const names = await Promise.all(found.map((el) => el.getText()))
    // Evidence for the run log: which projects this machine's scan found.
    console.log(`[this-computer] paratext projects found: ${found.length}`, names)

    expect(await browser.execute(() => localStorage.getItem("aq.paratext-scan.v1"))).toBe("ok")
  })
})
