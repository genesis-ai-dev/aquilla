import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Page } from "@playwright/test"

const directory = path.dirname(fileURLToPath(import.meta.url))
export const JEV_REVISION = "1231850a0bf1a0c0341fe408ef1668dbbfdfac46"

export interface AgentAction {
  kind: string
  label: string
  text: string | null
}

export interface AgentRun {
  status: string
  steps: Record<string, unknown>[]
  actions: AgentAction[]
  modelCalls: { kind: string; model: string; elapsedMs: number; usage: Record<string, number> }[]
  elapsedMs: number
}

/** Jev chooses observed actions on this page; models supply no selectors or code. */
export async function runJev(
  page: Page,
  goal: string,
  options: {
    timeoutMs?: number
    maxDecisions?: number
    onAction?: (action: AgentAction) => Promise<boolean>
    onEvidence?: (run: AgentRun) => void
  } = {},
): Promise<AgentRun> {
  if (!process.env.TYPESAFE_API_KEY || !process.env.TEXT_MODEL_API_KEY) {
    throw new Error("Set TYPESAFE_API_KEY and TEXT_MODEL_API_KEY before running live Jev journeys")
  }
  const timeoutMs = options.timeoutMs ?? 90_000
  const session = await page.context().newCDPSession(page)
  const child = spawn(path.join(directory, ".venv/bin/python"), [
    "-u", path.join(directory, "jev_bridge.py"),
  ], { stdio: ["pipe", "pipe", "pipe"], env: process.env })
  const started = Date.now()
  const run: AgentRun = { status: "incomplete", steps: [], actions: [], modelCalls: [], elapsedMs: 0 }
  const lines = createInterface({ input: child.stdout })
  // Consume stderr without including private subprocess output in artifacts.
  child.stderr.resume()
  child.stdin.on("error", () => { /* exit handler records the broken bridge */ })
  let timedOut = false
  let processError = false
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", () => { processError = true; resolve(null) })
    child.on("exit", resolve)
  })
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, timeoutMs)
  const reply = (result: unknown) => {
    if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ result }) + "\n")
  }
  child.stdin.write(JSON.stringify({
    url: page.url(), goal, max_decisions: options.maxDecisions ?? 60,
    timeout_seconds: timeoutMs / 1000,
  }) + "\n")
  try {
    for await (const line of lines) {
      const message = JSON.parse(line)
      if (message.type === "cdp") {
        try {
          reply(await session.send(message.method, message.params))
        } catch {
          child.stdin.write(JSON.stringify({ error: "Browser command failed" }) + "\n")
        }
      } else if (message.type === "ready") {
        const waitStarted = Date.now()
        try {
          await page.waitForLoadState("domcontentloaded", { timeout: 15_000 })
          await page.waitForFunction(() => !Array.from(document.querySelectorAll('[aria-busy="true"]'))
            .some((element) => {
              const bounds = element.getBoundingClientRect()
              return bounds.width > 0 && bounds.height > 0
                && bounds.bottom > 0 && bounds.top < innerHeight
                && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            }), undefined, { timeout: 15_000 })
          reply({})
        } catch {
          child.stdin.write(JSON.stringify({ error: "Loading state did not settle" }) + "\n")
        }
        run.steps.push({ operation: "READINESS", elapsed_ms: Date.now() - waitStarted })
      } else if (message.type === "action") {
        run.actions.push(message.action)
        reply({ stop: await options.onAction?.(message.action) ?? false })
      } else if (message.type === "step") {
        run.steps.push(message.step)
        console.log(`[Jev] ${message.step.actions} actions · ${message.step.operation} · ${message.step.elapsed_ms} ms`)
      } else if (message.type === "model_call") {
        run.modelCalls.push(message.call)
      } else if (message.type === "result") {
        run.status = message.status
      } else if (message.type === "error") {
        run.status = "driver_error"
        run.steps.push({ operation: "ERROR", error: message.error, reason: message.reason })
      }
      run.elapsedMs = Date.now() - started
      if (message.type !== "cdp") options.onEvidence?.(run)
    }
    const code = await exited
    if (timedOut) run.status = "timed_out"
    else if (processError || code !== 0) run.status = "driver_error"
    return run
  } finally {
    clearTimeout(timer)
    child.kill("SIGKILL")
    lines.close()
    await session.detach().catch(() => {})
    run.elapsedMs = Date.now() - started
    options.onEvidence?.(run)
  }
}
