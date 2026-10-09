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

import { createBridgeHost, type RenderReport, type ToolErrorReport } from "./host-bridge"
import { createToolHandlers, type ToolAudioEntry, type ToolCellView, type ToolHostData, type ToolPresence } from "./host-handlers"
import { TOOL_SANDBOX, buildToolSrcdoc } from "./srcdoc"
import type { ToolManifest, ToolMount } from "../../../shared/tools/manifest"
import { stubEditorData } from "./smoke-editor"
import { stubRev4Data } from "./smoke-rev4"
import { uiStrings } from "./ui-strings"

export const SMOKE_LOAD_TIMEOUT_MS = 8000
export const SMOKE_QUIET_MS = 900
export const SMOKE_MAX_MS = 6000

export interface SmokeFixture {
  label: "empty" | "populated" | `populated (${string})`
  data: ToolHostData
  /** Push after the tool settles (e.g. a cells.changed). */
  afterSettle?: { type: string } & Record<string, unknown>
  /** The mount to render as (default "smoke": no context). */
  mount?: ToolMount
  /** Fail the run if, once settled, the tool shows nothing (render.check). */
  mustRender?: boolean
}

/** Where a smoke run renders. The default is a real hidden sandboxed iframe;
 *  tests substitute an in-process fake. */
export interface SmokeFrame {
  /** The tool's window (what bridge messages must come from). */
  readonly toolWindow: Window | null
  /** The window the host listens on for the tool's messages. */
  readonly hostWindow: Window
  start: (srcdoc: string, width?: number) => void
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
    start: (srcdoc, width) => {
      if (width) iframe.style.width = `${width}px`
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
  { cellId: "c1", ref: "MAT 1:1", source: "The book of the genealogy of Jesus Christ", target: "Libro de la genealogía de Jesucristo", validated: true, chapter: "MAT 1", targetHtml: "<p>Libro de la <b>genealogía</b> de Jesucristo</p>" },
  { cellId: "c2", ref: "MAT 1:2", source: "Abraham was the father of Isaac", target: "Abraham engendró a Isaac", validated: false, chapter: "MAT 1" },
  { cellId: "c3", ref: "MAT 2:1", source: "Jesus was born in Bethlehem", target: "", validated: false, chapter: "MAT 2" },
  { cellId: "c4", ref: null, source: "Heading", target: "Encabezado", validated: false, chapter: null, type: "heading" },
]

function stubData(populated: boolean, scopes: ToolManifest["scopes"]): ToolHostData {
  const store = new Map<string, unknown>()
  return {
    ...stubEditorData(populated),
    ...stubRev4Data(populated),
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
    // apiRev 2
    pageCells: async (fileId, _lane, cursor, limit) => {
      const all = populated && fileId === "f1" ? SAMPLE_CELLS.map((c) => ({ ...c })) : []
      const start = cursor ? Number(cursor) || 0 : 0
      const cells = all.slice(start, start + limit)
      const next = start + limit < all.length ? String(start + limit) : null
      return { cells, nextCursor: next, total: all.length }
    },
    getCells: async (fileId, cellIds) =>
      populated && fileId === "f1" ? SAMPLE_CELLS.filter((c) => cellIds.includes(c.cellId)).map((c) => ({ ...c })) : [],
    unvalidate: async (items) => ({ validated: items.map((i) => i.cellId), failed: [] }),
    listPresence: async (): Promise<ToolPresence> => (populated ? { c3: { username: "someone" } } : {}),
    claimCell: async () => true,
    releaseCell: async () => true,
    commentCounts: async (fileId): Promise<Record<string, number>> => (populated && fileId === "f1" ? { c2: 1 } : {}),
    openComments: async () => true,
    listAudio: async (fileId): Promise<Record<string, ToolAudioEntry>> => (populated && fileId === "f1" ? { c1: { hasAudio: true, durationMs: 1200 } } : {}),
    playAudio: async () => true,
    stopAudio: async () => true,
    hostKey: async () => false,
    uiStrings: async (keys) => uiStrings("en", keys),
  }
}

/** Empty data once, then populated data in EVERY mount the manifest declares
 *  — each populated render must actually show something (a tool that loads
 *  but draws nothing in its side panel is a broken build). */
export function defaultSmokeFixtures(manifest: ToolManifest): SmokeFixture[] {
  const mounts: ToolMount[] = manifest.mounts.length > 0 ? [...manifest.mounts] : ["page"]
  return [
    { label: "empty", data: stubData(false, manifest.scopes) },
    ...mounts.map((mount, i): SmokeFixture => ({
      label: mounts.length === 1 && mount === "page" ? "populated" : `populated (${mount})`,
      data: stubData(true, manifest.scopes),
      mount,
      mustRender: true,
      // The live push is exercised once.
      ...(i === 0 ? { afterSettle: { type: "cells.changed", fileId: "f1", cellIds: ["c2"] } } : {}),
    })),
  ]
}

/** Frame width per mount (the side panel is narrow). */
const MOUNT_WIDTH: Record<string, number> = { panel: 320, inline: 640, editor: 1024, page: 1024 }

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
    let checkedRender = false
    let lastRender: RenderReport | null = null
    let renderWaiter: (() => void) | null = null
    const finish = () => {
      if (done) return
      if (fixture.mustRender && !checkedRender) {
        // Ask the frame what it draws, then finish (≤1 s for the answer).
        checkedRender = true
        const giveUp = setTimeout(() => renderWaiter?.(), 1000)
        renderWaiter = () => {
          clearTimeout(giveUp)
          renderWaiter = null
          if (!lastRender || lastRender.empty) {
            errors.push({
              message: `the tool rendered nothing on screen in the "${fixture.mount ?? "page"}" mount with sample data (blank body). It must always show its UI: a heading, the data, or an empty-state message.`,
              stack: "",
            })
          }
          finish()
        }
        host.push({ type: "render.check" })
        return
      }
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
      onRender: (report) => {
        lastRender = report
        renderWaiter?.()
      },
    })
    const stop = host.listen(frame.hostWindow)
    const loadTimer = setTimeout(() => {
      errors.push({ message: `the tool did not finish loading within ${SMOKE_LOAD_TIMEOUT_MS} ms`, stack: "" })
      finish()
    }, SMOKE_LOAD_TIMEOUT_MS)
    const maxTimer = setTimeout(finish, SMOKE_LOAD_TIMEOUT_MS + SMOKE_MAX_MS)

    frame.start(buildToolSrcdoc(source, {
      tool: { id: "smoke", name: manifest.name, version: 0, scopes: manifest.scopes },
      project: { id: "smoke-project", name: "Smoke test project" },
      user: { username: "smoke", roleLevel: 700 },
      mount: fixture.mount ?? "smoke",
      ...(fixture.mount === "editor" ? { file: { fileId: "f1", name: "MAT" } } : {}),
      ...(fixture.mount === "inline" ? { cell: { fileId: "f1", cellId: "c1" } } : {}),
      theme: {},
    }, { sdk: manifest.sdk }), MOUNT_WIDTH[fixture.mount ?? "page"] ?? 1024)
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
