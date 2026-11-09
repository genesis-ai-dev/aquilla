import { describe, expect, it } from "vitest"
import { backstopMs, DEFAULT_TIMEOUT_MS, execCode, MAX_TIMEOUT_MS, START_GRACE_MS } from "../src/exec"
import type { SandboxLike, SandboxRunResult } from "../src/sandbox"

function fake(run: (code: string, options?: { language?: string; timeout?: number }) => Promise<SandboxRunResult>) {
  const calls: Array<{ code: string; options?: { language?: string; timeout?: number } }> = []
  const sandbox: SandboxLike = {
    async runCode(code, options) {
      calls.push({ code, options })
      return run(code, options)
    },
    async writeFile(path) {
      return { success: true, path }
    },
    async readFile(path) {
      return { success: true, path, content: "" }
    },
    async destroy() {},
  }
  return { sandbox, calls }
}

const ok = (stdout: string): SandboxRunResult => ({ logs: { stdout: [stdout], stderr: [] }, results: [] })

describe("execCode", () => {
  it("passes the clamped timeout and the interpreter language to the sandbox", async () => {
    const { sandbox, calls } = fake(async () => ok(""))
    await execCode(sandbox, { language: "js", code: "1" })
    await execCode(sandbox, { language: "python", code: "1", timeoutMs: 10_000_000 })
    expect(calls[0].options).toEqual({ language: "javascript", timeout: DEFAULT_TIMEOUT_MS })
    expect(calls[1].options).toEqual({ language: "python", timeout: MAX_TIMEOUT_MS })
  })

  it("reports a container-side TimeoutError as the timeout contract, keeping what was printed", async () => {
    const { sandbox } = fake(async () => ({
      logs: { stdout: ["tick\ntick\n"], stderr: ["noise"] },
      error: { name: "TimeoutError", message: "Command timeout after 50ms" },
      results: [{ json: "ignored" }],
    }))
    const out = await execCode(sandbox, { language: "python", code: "while True: pass", timeoutMs: 50 })
    expect(out.ok).toBe(false)
    expect(out.stderr).toBe("timeout")
    expect(out.stdout).toBe("tick\ntick\n")
    expect(out.resultJson).toBeUndefined()
  })

  it("renders a ProcessExit like any interpreter error", async () => {
    const { sandbox } = fake(async () => ({
      logs: { stdout: [], stderr: ["Killed\n"] },
      error: { name: "ProcessExit", message: "process exited with code 137" },
      results: [],
    }))
    const out = await execCode(sandbox, { language: "python", code: "x" })
    expect(out.ok).toBe(false)
    expect(out.stderr).toBe("Killed\nProcessExit: process exited with code 137\n")
  })

  it("maps a thrown timeout message to the timeout contract", async () => {
    const { sandbox } = fake(async () => {
      throw new Error("Command timeout after 60000ms")
    })
    const out = await execCode(sandbox, { language: "js", code: "x" })
    expect(out).toMatchObject({ ok: false, stdout: "", stderr: "timeout" })
  })

  it("falls back to the backstop when the sandbox never answers", async () => {
    const { sandbox } = fake(() => new Promise<SandboxRunResult>(() => {}))
    const started = Date.now()
    const out = await execCode(sandbox, { language: "js", code: "hang", timeoutMs: 10 })
    expect(out).toMatchObject({ ok: false, stdout: "", stderr: "timeout" })
    expect(Date.now() - started).toBeLessThan(START_GRACE_MS)
  })

  it("gives the backstop a cold-start allowance bounded by the timeout itself", () => {
    expect(backstopMs(20)).toBe(40)
    expect(backstopMs(DEFAULT_TIMEOUT_MS)).toBe(DEFAULT_TIMEOUT_MS + START_GRACE_MS)
    expect(backstopMs(MAX_TIMEOUT_MS)).toBe(MAX_TIMEOUT_MS + START_GRACE_MS)
  })
})
