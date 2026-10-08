/**
 * Pre-save smoke render — the last builder gate.
 *
 * Runs a candidate tool CLIENT-SIDE in a hidden iframe with the same sandbox
 * and CSP as a real mount, against a stub bridge (no project data, no
 * writes), twice: once EMPTY (no files) and once POPULATED (files, cells,
 * terms, then a live cells.changed push). Any uncaught error, rejected
 * promise, or a frame that never loads fails the gate, and the error text goes
 * back to the model for repair. Generated code therefore never executes on a
 * server, next to secrets.
 */

import { createBridgeHost, type ToolErrorReport } from "./host-bridge"
import { createToolHandlers, type ToolCellView, type ToolHostData } from "./host-handlers"
import { TOOL_SANDBOX, buildToolSrcdoc } from "./srcdoc"
import type { ToolManifest } from "../../../shared/tools/manifest"

export const SMOKE_LOAD_TIMEOUT_MS = 8000
export const SMOKE_QUIET_MS = 900
export const SMOKE_MAX_MS = 6000

export interface SmokeFixture {
  label: "empty" | "populated"
  data: ToolHostData
  /** Push after the tool settles (e.g. a cells.changed). */
  afterSettle?: { type: string } & Record<string, unknown>
}

/** Where a smoke run renders. The default is a real hidden sandboxed iframe;
 *  tests substitute an in-process fake. */
export interface SmokeFrame {
  /** The tool's window (what bridge messages must come from). */
  readonly toolWindow: Window | null
  /** The window the host listens on for the tool's messages. */
  readonly hostWindow: Window
  start: (srcdoc: string) => void
  dispose: () => void
}

export function createIframeSmokeFrame(label: string): SmokeFrame {
  const iframe = document.createElement("iframe")
  iframe.setAttribute("sandbox", TOOL_SANDBOX)
  iframe.setAttribute("aria-hidden", "true")
  iframe.title = `smoke-${label}`
  Object.assign(iframe.style, { position: "fixed", left: "-10000px", top: "0", width: "1024px", height: "768px", border: "0" })
  return {
    get toolWindow() {
      return iframe.contentWindow
    },
    hostWindow: window,
    start: (srcdoc) => {
      iframe.srcdoc = srcdoc
      document.body.appendChild(iframe)
    },
    dispose: () => iframe.remove(),
  }
}

export interface SmokeResult {
  ok: boolean
  errors: { state: string; message: string; stack: string }[]
  calls: Record<string, number>
}

const SAMPLE_CELLS: ToolCellView[] = [
  { cellId: "c1", ref: "MAT 1:1", source: "The book of the genealogy of Jesus Christ", target: "Libro de la genealogía de Jesucristo", validated: true, chapter: "MAT 1" },
  { cellId: "c2", ref: "MAT 1:2", source: "Abraham was the father of Isaac", target: "Abraham engendró a Isaac", validated: false, chapter: "MAT 1" },
  { cellId: "c3", ref: "MAT 2:1", source: "Jesus was born in Bethlehem", target: "", validated: false, chapter: "MAT 2" },
  { cellId: "c4", ref: null, source: "Heading", target: "Encabezado", validated: false, chapter: null },
]

function stubData(populated: boolean, scopes: ToolManifest["scopes"]): ToolHostData {
  const store = new Map<string, unknown>()
  return {
    listFiles: async () => (populated ? [{ fileId: "f1", name: "MAT", cellCount: SAMPLE_CELLS.length }, { fileId: "f2", name: "Empty", cellCount: 0 }] : []),
    listCells: async (fileId) => (populated && fileId === "f1" ? SAMPLE_CELLS.map((c) => ({ ...c })) : []),
    listTerms: async () =>
      populated
        ? [
            { id: "t1", term: "Jesus", renderings: [{ rendering: "Jesús", status: "approved" }], notes: null },
            { id: "t2", term: "Bethlehem", renderings: [{ rendering: "Belén", status: "approved" }, { rendering: "Betlehem", status: "rejected" }], notes: "town" },
          ]
        : [],
    commit: async (edits) => ({ committed: edits.map((e) => e.cellId), failed: [] }),
    validate: async (items) => ({ validated: items.map((i) => i.cellId), failed: [] }),
    storageGet: async (k) => store.get(k) ?? null,
    storageSet: async (k, v) => {
      store.set(k, v)
    },
    storageRemove: async (k) => {
      store.delete(k)
    },
    notify: () => {},
    generate: async ({ prompt }) => ({ text: `(generated for: ${prompt.slice(0, 40)})` }),
    tell: () => {},
    grantedScopes: () => [...scopes],
    requestScope: async () => true,
  }
}

export function defaultSmokeFixtures(manifest: ToolManifest): SmokeFixture[] {
  return [
    { label: "empty", data: stubData(false, manifest.scopes) },
    {
      label: "populated",
      data: stubData(true, manifest.scopes),
      afterSettle: { type: "cells.changed", fileId: "f1", cellIds: ["c2"] },
    },
  ]
}

function runOne(
  source: string,
  manifest: ToolManifest,
  fixture: SmokeFixture,
  calls: Record<string, number>,
  createFrame: (label: string) => SmokeFrame,
  allowedOrigins: readonly string[],
): Promise<ToolErrorReport[]> {
  return new Promise((resolve) => {
    const errors: ToolErrorReport[] = []
    const frame = createFrame(fixture.label)

    let inFlight = 0
    let quietTimer: ReturnType<typeof setTimeout> | null = null
    let pushed = false
    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (quietTimer) clearTimeout(quietTimer)
      clearTimeout(loadTimer)
      clearTimeout(maxTimer)
      stop()
      frame.dispose()
      resolve(errors)
    }
    const armQuiet = () => {
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => {
        if (inFlight > 0) return armQuiet()
        if (fixture.afterSettle && !pushed) {
          pushed = true
          host.push(fixture.afterSettle)
          return armQuiet()
        }
        finish()
      }, SMOKE_QUIET_MS)
    }

    const handlers = createToolHandlers(fixture.data)
    const counted = Object.fromEntries(
      Object.entries(handlers).map(([method, h]) => [
        method,
        async (params: unknown) => {
          calls[method] = (calls[method] ?? 0) + 1
          inFlight++
          try {
            return await h(params)
          } finally {
            inFlight--
            armQuiet()
          }
        },
      ]),
    )
    const host = createBridgeHost({
      getFrameWindow: () => frame.toolWindow,
      allowedOrigins,
      handlers: counted,
      authorize: async () => {},
      onReady: () => {
        clearTimeout(loadTimer)
        armQuiet()
      },
      onToolError: (err) => errors.push(err),
    })
    const stop = host.listen(frame.hostWindow)
    const loadTimer = setTimeout(() => {
      errors.push({ message: `the tool did not finish loading within ${SMOKE_LOAD_TIMEOUT_MS} ms`, stack: "" })
      finish()
    }, SMOKE_LOAD_TIMEOUT_MS)
    const maxTimer = setTimeout(finish, SMOKE_LOAD_TIMEOUT_MS + SMOKE_MAX_MS)

    frame.start(buildToolSrcdoc(source, {
      tool: { id: "smoke", name: manifest.name, version: 0 },
      project: { id: "smoke-project", name: "Smoke test project" },
      user: { username: "smoke", roleLevel: 700 },
      mount: "smoke",
      theme: {},
    }))
  })
}

/** Run the smoke gate. Never throws; returns every error it saw. */
export interface SmokeOptions {
  fixtures?: SmokeFixture[]
  createFrame?: (label: string) => SmokeFrame
  allowedOrigins?: readonly string[]
}

export async function runToolSmoke(source: string, manifest: ToolManifest, opts: SmokeOptions = {}): Promise<SmokeResult> {
  const fixtures = opts.fixtures ?? defaultSmokeFixtures(manifest)
  const createFrame = opts.createFrame ?? createIframeSmokeFrame
  const allowedOrigins = opts.allowedOrigins ?? ["null"]
  const errors: SmokeResult["errors"] = []
  const calls: Record<string, number> = {}
  for (const fixture of fixtures) {
    const found = await runOne(source, manifest, fixture, calls, createFrame, allowedOrigins)
    for (const e of found) errors.push({ state: fixture.label, ...e })
  }
  return { ok: errors.length === 0, errors, calls }
}

export function formatSmokeErrors(result: SmokeResult): string {
  return result.errors
    .map((e) => `- [${e.state} state] ${e.message}${e.stack ? `\n  ${e.stack.split("\n").slice(0, 4).join("\n  ")}` : ""}`)
    .join("\n")
}
