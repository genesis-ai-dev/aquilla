#!/usr/bin/env tsx
/**
 * AQU-2654 — the interaction benchmark: what one click, one keystroke, one
 * commit and one return to the tab cost in the real editor.
 *
 *   pnpm dev                          # the local stack (auth :8788, sync :8789)
 *   pnpm perf:interaction             # build, serve, seed if needed, measure, enforce budgets
 *   pnpm perf:interaction --no-build  # reuse .perf/interaction-dist from the last run
 *   pnpm perf:interaction --only plain --throttle 1
 *   pnpm perf:interaction --suggest-budgets
 *   pnpm perf:interaction --no-ghost-text   # see the flag's note in measureVariant
 *
 * Two fixtures of the same small project (2 files, 400 cells): `plain`, and
 * `glossary` with 664 active terms that use forms, affixes and mark folding —
 * the shape of the project the ticket came from. A small project on purpose:
 * the cost this measures does not come from the size of the data.
 *
 * It measures a PRODUCTION build (unminified, so the report can name the
 * components that rendered), signed in through the dev stack's login bypass.
 * `--throttle 4` (the default) is Chrome's CPU slowdown: a datacentre core is
 * several times faster than the laptop a translator types on.
 *
 * Budgets: `scripts/perf/interaction-budgets.json`. The count metrics
 * (commits, renders, requests) are the contract; see lib/interaction-probe.ts.
 */

import { parseArgs } from "node:util"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { v7 as uuidv7 } from "uuid"
import type { Page } from "@playwright/test"
import { devLogin, mintSyncToken, postEvents, DEFAULT_TARGET, type PerfTarget, type RawEventInput } from "./lib/client"
import { readHandle, type BigBibleHandle } from "./lib/fixture-handle"
import { evaluateBudgets, parseBudgetFile, renderBreaches } from "./lib/budgets"
import {
  HIDE_TAB,
  INTERACTION_INIT_SCRIPT,
  READ_PROBE,
  RESET_PROBE,
  rendersOf,
  routeKey,
  showTabScript,
  summarizePhase,
  type PhaseResult,
  type ProbeReading,
  type RequestTally,
} from "./lib/interaction-probe"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const DIST_DIR = path.join(REPO_ROOT, ".perf", "interaction-dist")
const REPORT_DIR = path.join(REPO_ROOT, "perf-report")
const BUDGETS_PATH = path.join(REPO_ROOT, "scripts", "perf", "interaction-budgets.json")
const PREVIEW_PORT = 4175
const CLOUD_CHROMIUM = "/opt/pw-browsers/chromium"
const ROW = "[data-cell-id]"
/** Stall watchdog, not a target (AGENTS.md rule 15). */
const READY_TIMEOUT_MS = 600_000
const TERM_COUNT = 664
const VARIANTS = ["plain", "glossary"] as const
type Variant = (typeof VARIANTS)[number]

/** Words the seeded source text really contains, so some terms match. */
const MATCHING_TERMS = ["beginning", "waters", "light", "darkness", "Spirit", "earth", "deep", "void", "good", "face", "form", "God"]

interface Options {
  variants: Variant[]
  throttle: number
  build: boolean
  appBase: string | null
  suggestBudgets: boolean
  enforce: boolean
  /** False: the editor's ghost-text suggestions are switched off for the run. */
  ghostText: boolean
  target: PerfTarget
}

function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      only: { type: "string" },
      throttle: { type: "string" },
      "no-build": { type: "boolean" },
      "app-base": { type: "string" },
      "suggest-budgets": { type: "boolean" },
      "no-budgets": { type: "boolean" },
      "no-ghost-text": { type: "boolean" },
    },
  })
  const only = values.only?.split(",").map((s) => s.trim()).filter(Boolean)
  for (const name of only ?? []) {
    if (!VARIANTS.includes(name as Variant)) throw new Error(`--only takes ${VARIANTS.join(",")}; got ${name}`)
  }
  const throttle = Number(values.throttle ?? 4)
  if (!Number.isFinite(throttle) || throttle < 1) throw new Error("--throttle must be a number >= 1")
  return {
    variants: (only as Variant[] | undefined) ?? [...VARIANTS],
    throttle,
    build: !values["no-build"],
    appBase: values["app-base"] ?? null,
    suggestBudgets: !!values["suggest-budgets"],
    enforce: !values["no-budgets"],
    ghostText: !values["no-ghost-text"],
    target: DEFAULT_TARGET,
  }
}

const log = (line: string) => console.log(`[perf] ${line}`)

// ── fixture ────────────────────────────────────────────────────────────────

function handlePath(variant: Variant): string {
  return path.join(REPO_ROOT, ".perf", `interaction-${variant}.json`)
}

async function ensureFixture(variant: Variant, target: PerfTarget): Promise<BigBibleHandle> {
  const file = handlePath(variant)
  if (!existsSync(file)) {
    log(`seeding the ${variant} fixture (2 files, 400 cells)`)
    const seeded = spawnSync(
      "pnpm",
      ["exec", "tsx", "scripts/perf/seed-big-bible.ts", "--books", "2", "--cells", "400", "--name", `Interaction perf (${variant})`, "--handle", file],
      { cwd: REPO_ROOT, stdio: "inherit" },
    )
    if (seeded.status !== 0) throw new Error(`seeding the ${variant} fixture failed — is the dev stack running (pnpm dev)?`)
    if (variant === "glossary") await seedGlossary(readHandle(file), target)
  }
  return readHandle(file)
}

async function seedGlossary(handle: BigBibleHandle, target: PerfTarget): Promise<void> {
  const session = await devLogin(target)
  const token = await mintSyncToken(target, session.jwt, handle.projectId, "__project__")
  const lane = handle.lanes.find((l) => l.role === "target")
  if (!lane) throw new Error("the fixture has no target lane to attach renderings to")
  const events: RawEventInput[] = []
  for (let i = 0; i < TERM_COUNT; i++) {
    // The first few match the source text; the rest are the long tail every
    // real glossary has — present, compiled, and matching nothing on screen.
    const term = i < MATCHING_TERMS.length ? MATCHING_TERMS[i] : `glossaryterm${i}`
    events.push({
      id: uuidv7(),
      schemaVersion: 1,
      kind: "term.create",
      projectId: handle.projectId,
      fileId: "__project__",
      parentId: null,
      author: session.username,
      clientTs: Date.now(),
      payload: {
        conceptId: randomUUID(),
        sourceTerm: term,
        status: "active",
        renderings: [
          { rendering: `rendu${i}`, status: "preferred", laneId: lane.id },
          { rendering: `variante${i}`, status: "admitted", laneId: lane.id },
        ],
        match: { foldMarks: true, affixes: true, forms: [`${term}s`, `${term}ed`], excludedForms: [`${term}less`] },
      },
    })
  }
  for (let i = 0; i < events.length; i += 100) await postEvents(target, token, events.slice(i, i + 100))
  log(`seeded ${TERM_COUNT} glossary terms`)
}

// ── build + serve ──────────────────────────────────────────────────────────

function buildApp(target: PerfTarget): void {
  log("building the SPA (production, unminified) → .perf/interaction-dist")
  const built = spawnSync("pnpm", ["exec", "vite", "build", "--minify", "false", "--outDir", DIST_DIR, "--logLevel", "warn"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_AUTH_BASE: target.authBase,
      VITE_SYNC_WORKER_HOST: new URL(target.syncBase).host,
      VITE_CHAT_BASE: `${target.authBase}/chat`,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? "--max-old-space-size=8192",
    },
  })
  if (built.status !== 0) throw new Error("vite build failed")
}

async function servePreview(): Promise<{ base: string; stop: () => void }> {
  const child: ChildProcess = spawn(
    "pnpm",
    ["exec", "vite", "preview", "--outDir", DIST_DIR, "--port", String(PREVIEW_PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: REPO_ROOT, stdio: "ignore", detached: true },
  )
  const base = `http://127.0.0.1:${PREVIEW_PORT}`
  const stop = () => {
    try {
      if (child.pid) process.kill(-child.pid)
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      if ((await fetch(base)).ok) return { base, stop }
    } catch {
      // not listening yet
    }
    if (child.exitCode !== null) throw new Error(`vite preview exited (${child.exitCode}) — is port ${PREVIEW_PORT} in use?`)
    if (Date.now() > deadline) {
      stop()
      throw new Error("vite preview did not start within 60s")
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

// ── measurement ────────────────────────────────────────────────────────────

interface Recorder {
  begin(): Promise<void>
  /** Wait until no request has started for `quietMs`, then read the probe. */
  end(name: string, extra?: Record<string, number>, settle?: boolean): Promise<{ phase: PhaseResult; reading: ProbeReading }>
  requestCount(): number
}

function createRecorder(page: Page, appOrigin: string): Recorder {
  let started: Array<{ route: string; request: unknown }> = []
  const sizes = new Map<unknown, number>()
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.origin === appOrigin) return // the app's own static assets
    started.push({ route: routeKey(request.method(), url.pathname), request })
  })
  page.on("response", (response) => {
    response.body().then((body) => sizes.set(response.request(), body.length), () => {})
  })
  const settleQuiet = async (quietMs: number, capMs: number) => {
    const t0 = Date.now()
    let seen = started.length
    let lastChange = Date.now()
    while (Date.now() - t0 < capMs) {
      await page.waitForTimeout(150)
      if (started.length !== seen) {
        seen = started.length
        lastChange = Date.now()
      } else if (Date.now() - lastChange >= quietMs) return
    }
  }
  return {
    async begin() {
      started = []
      await page.evaluate(RESET_PROBE)
    },
    async end(name, extra = {}, settle = true) {
      if (settle) await settleQuiet(2_500, 60_000)
      const reading = (await page.evaluate(READ_PROBE)) as ProbeReading
      if (reading.react.error) throw new Error(`render counter failed: ${reading.react.error}`)
      const tally: RequestTally = { count: started.length, bytes: 0, byRoute: {} }
      for (const entry of started) {
        tally.bytes += sizes.get(entry.request) ?? 0
        tally.byRoute[entry.route] = (tally.byRoute[entry.route] ?? 0) + 1
      }
      return { phase: summarizePhase(name, reading, tally, extra), reading }
    },
    requestCount: () => started.length,
  }
}

async function signIn(page: Page, appBase: string, target: PerfTarget): Promise<void> {
  // The production build has no /__dev/login route, so write the session the
  // way the app stores it (src/lib/frontier/session-store.ts) and let it boot.
  const session = await devLogin(target)
  await page.goto(`${appBase}/login`, { waitUntil: "commit", timeout: READY_TIMEOUT_MS })
  await page.evaluate(
    `(async (s) => {
      const open = indexedDB.open("frontier", 1);
      open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains("session")) open.result.createObjectStore("session"); };
      await new Promise((res, rej) => { open.onsuccess = res; open.onerror = () => rej(open.error); });
      const tx = open.result.transaction("session", "readwrite");
      tx.objectStore("session").put({ active: s.username, sessions: { [s.username]: s } }, "envelope");
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
      open.result.close();
    })(${JSON.stringify({ jwt: session.jwt, username: session.username, email: `${session.username}@example.com`, createdAt: new Date().toISOString() })})`,
  )
}

async function measureVariant(
  variant: Variant,
  handle: BigBibleHandle,
  appBase: string,
  options: Options,
): Promise<{ metrics: Record<string, number>; phases: PhaseResult[] }> {
  const { chromium } = await import("@playwright/test")
  // A cloud session ships its own Chromium, not the one this lockfile pins.
  const chrome = process.env.PERF_CHROME ?? (existsSync(CLOUD_CHROMIUM) ? CLOUD_CHROMIUM : null)
  const browser = await chromium.launch(chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : {})
  const metrics: Record<string, number> = {}
  const phases: PhaseResult[] = []
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript({ content: INTERACTION_INIT_SCRIPT })
    // `--no-ghost-text`: a visible ghost suggestion takes Tab (accept) ahead of
    // cell navigation, and whether one is visible when editTab presses Tab is
    // a race between the suggestion's 250 ms debounce and the main thread. The
    // flag takes the race out: the preference is the one View settings writes
    // (src/lib/store/ghost-text-pref.ts).
    if (!options.ghostText) {
      await context.addInitScript({ content: 'try { localStorage.setItem("aq.ghost-text.v3", "off") } catch {}' })
    }
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    const recorder = createRecorder(page, new URL(appBase).origin)
    const file = handle.files[0]
    const targetCell = (i: number) => page.locator(ROW).nth(i).locator('[data-cell-type="target"]')
    const editable = (i: number) => targetCell(i).locator('.ProseMirror[contenteditable="true"], textarea').first()
    const put = (phase: string, values: Record<string, number | null>) => {
      for (const [key, value] of Object.entries(values)) {
        if (value !== null) metrics[`${variant}.${phase}.${key}`] = value
      }
    }
    const record = (result: { phase: PhaseResult }) => {
      phases.push(result.phase)
      log(
        `${variant} ${result.phase.name}: ${result.phase.reactCommits} commits, ${result.phase.componentRenders} renders, `
          + `${result.phase.longTaskTotalMs}ms blocked, ${result.phase.requests.count} requests`,
      )
    }

    await signIn(page, appBase, options.target)
    if (options.throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.throttle })

    // open
    await recorder.begin()
    let t0 = Date.now()
    await page.goto(`${appBase}/project/${handle.projectId}/editor/file/${file.id}`, { waitUntil: "commit", timeout: READY_TIMEOUT_MS })
    await page.locator(ROW).first().waitFor({ state: "visible", timeout: READY_TIMEOUT_MS })
    const readyMs = Date.now() - t0
    let result = await recorder.end("open", { readyMs })
    record(result)
    put("open", {
      readyMs,
      longTaskTotalMs: result.phase.longTaskTotalMs,
      longestTaskMs: result.phase.longestTaskMs,
      reactCommits: result.phase.reactCommits,
      componentRenders: result.phase.componentRenders,
      requests: result.phase.requests.count,
    })

    // activate: click into a cell that is not being edited
    await targetCell(0).click({ timeout: READY_TIMEOUT_MS })
    await editable(0).waitFor({ state: "visible", timeout: READY_TIMEOUT_MS })
    await recorder.end("warm-up")
    await recorder.begin()
    t0 = Date.now()
    await targetCell(2).click({ timeout: READY_TIMEOUT_MS })
    await editable(2).waitFor({ state: "visible", timeout: READY_TIMEOUT_MS })
    const activateMs = Date.now() - t0
    result = await recorder.end("activate", { activateMs })
    record(result)
    put("activate", {
      ms: activateMs,
      longTaskTotalMs: result.phase.longTaskTotalMs,
      reactCommits: result.phase.reactCommits,
      componentRenders: result.phase.componentRenders,
      requests: result.phase.requests.count,
    })

    // typing: 40 keystrokes, read before the idle commit fires
    await recorder.begin()
    const typed = "A sentence of forty characters to type. "
    await page.keyboard.type(typed, { delay: 60 })
    result = await recorder.end("typing", {}, false)
    record(result)
    put("typing", {
      inputToPaintP95Ms: result.phase.inputToPaintP95Ms,
      longTaskTotalMs: result.phase.longTaskTotalMs,
      componentRendersPerKey: Math.round(result.phase.componentRenders / typed.length),
    })

    // commit: the editor commits by itself once typing stops
    await recorder.begin()
    result = await recorder.end("commit")
    record(result)
    put("commit", {
      longTaskTotalMs: result.phase.longTaskTotalMs,
      reactCommits: result.phase.reactCommits,
      componentRenders: result.phase.componentRenders,
      workspaceRenders: rendersOf(result.reading, "ProjectWorkspace"),
      rowRenders: rendersOf(result.reading, "EditorRow"),
      requests: result.phase.requests.count,
    })

    // editTab: five short edits, Tab to the next cell after each
    const EDITS = 5
    await recorder.begin()
    const tabMs: number[] = []
    for (let i = 0; i < EDITS; i++) {
      await page.keyboard.type(`Short edit ${i} `, { delay: 40 })
      const before = await page.evaluate("document.activeElement && document.activeElement.closest('[data-cell-id]')?.getAttribute('data-cell-id')")
      t0 = Date.now()
      await page.keyboard.press("Tab")
      await page.waitForFunction(
        `(() => { const el = document.activeElement?.closest('[data-cell-id]'); return !!el && el.getAttribute('data-cell-id') !== ${JSON.stringify(before)}; })()`,
        undefined,
        { timeout: READY_TIMEOUT_MS },
      )
      tabMs.push(Date.now() - t0)
    }
    const tabSorted = [...tabMs].sort((a, b) => a - b)
    result = await recorder.end("editTab", { tabMaxMs: tabSorted[tabSorted.length - 1] })
    record(result)
    put("editTab", {
      tabMedianMs: tabSorted[Math.floor(tabSorted.length / 2)],
      tabMaxMs: tabSorted[tabSorted.length - 1],
      longTaskTotalMs: result.phase.longTaskTotalMs,
      reactCommitsPerEdit: Math.round(result.phase.reactCommits / EDITS),
      componentRendersPerEdit: Math.round(result.phase.componentRenders / EDITS),
      workspaceRendersPerEdit: Math.round((rendersOf(result.reading, "ProjectWorkspace") / EDITS) * 10) / 10,
      requestsPerEdit: Math.round((result.phase.requests.count / EDITS) * 10) / 10,
    })

    // tabReturn: hidden for 30s, then back
    await page.evaluate(HIDE_TAB)
    await page.waitForTimeout(30_000)
    await recorder.begin()
    await page.evaluate(showTabScript(6_000, ROW))
    await page.waitForTimeout(6_500)
    const rowFrames = (await page.evaluate("window.__interactionRowFrames")) as number[]
    const blankFrames = rowFrames.filter((rows) => rows === 0).length
    result = await recorder.end("tabReturn", { blankFrames })
    record(result)
    put("tabReturn", {
      longTaskTotalMs: result.phase.longTaskTotalMs,
      longestTaskMs: result.phase.longestTaskMs,
      reactCommits: result.phase.reactCommits,
      componentRenders: result.phase.componentRenders,
      requests: result.phase.requests.count,
      blankFrames,
    })
  } finally {
    await browser.close()
  }
  return { metrics, phases }
}

// ── budgets + report ───────────────────────────────────────────────────────

/** Counts get +25% headroom; timings get +100%, because machines differ. */
function suggestBudgets(metrics: Record<string, number>): { max: Record<string, number> } {
  const max: Record<string, number> = {}
  for (const [metric, value] of Object.entries(metrics)) {
    const isTiming = /Ms$/.test(metric)
    const headroom = isTiming ? 2 : 1.25
    const floor = isTiming ? 100 : 2
    max[metric] = Math.max(floor, Math.ceil(value * headroom))
  }
  return { max }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  let stopPreview: (() => void) | null = null
  let appBase = options.appBase
  try {
    if (!appBase) {
      if (options.build || !existsSync(path.join(DIST_DIR, "index.html"))) buildApp(options.target)
      const preview = await servePreview()
      appBase = preview.base
      stopPreview = preview.stop
    }
    const metrics: Record<string, number> = {}
    const phases: Record<string, PhaseResult[]> = {}
    for (const variant of options.variants) {
      const handle = await ensureFixture(variant, options.target)
      const measured = await measureVariant(variant, handle, appBase, options)
      Object.assign(metrics, measured.metrics)
      phases[variant] = measured.phases
    }

    const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim()
    const report = { harness: "interaction", sha, at: new Date().toISOString(), throttle: options.throttle, metrics, phases }
    mkdirSync(REPORT_DIR, { recursive: true })
    const stamp = report.at.replace(/[:.]/g, "-")
    writeFileSync(path.join(REPORT_DIR, `interaction-${stamp}.json`), JSON.stringify(report, null, 2))
    writeFileSync(path.join(REPORT_DIR, "interaction-latest.json"), JSON.stringify(report, null, 2))
    log(`report → perf-report/interaction-latest.json`)

    console.log("")
    for (const [metric, value] of Object.entries(metrics)) console.log(`  ${metric.padEnd(46)} ${value}`)
    console.log("")

    if (options.suggestBudgets) {
      console.log(JSON.stringify(suggestBudgets(metrics), null, 2))
      return
    }
    if (!options.enforce) return
    if (options.throttle !== 4) log("budgets are calibrated for --throttle 4; timing budgets may not apply to this run")
    const budgets = parseBudgetFile(JSON.parse(readFileSync(BUDGETS_PATH, "utf8")))
    const evaluation = evaluateBudgets(metrics, budgets)
    const partial = options.variants.length < VARIANTS.length
    for (const line of renderBreaches(evaluation.breaches)) console.error(line)
    if (!partial && evaluation.unmeasured.length > 0) {
      console.error(`[perf] budgeted but never measured: ${evaluation.unmeasured.join(", ")}`)
    }
    if (evaluation.breaches.length > 0 || (!partial && evaluation.unmeasured.length > 0)) {
      process.exitCode = 1
      return
    }
    log(`budgets held (${evaluation.passed.length} checked)`)
  } finally {
    stopPreview?.()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exit(1)
})
