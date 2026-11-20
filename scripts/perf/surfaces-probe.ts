#!/usr/bin/env tsx
/**
 * AQU-2654 — the surfaces probe: what opening and using every surface OUTSIDE
 * the cell editor costs, in the same currency as `interaction.ts` (React
 * commits, component renders, blocked main thread, requests per action).
 *
 *   pnpm dev                                                   # the local stack
 *   pnpm exec tsx scripts/perf/seed-big-bible.ts --books 2 --cells 400 --handle .perf/surfaces.json
 *   pnpm exec tsx scripts/perf/surfaces-probe.ts               # build, serve, measure, rank
 *   pnpm exec tsx scripts/perf/surfaces-probe.ts --no-build --only shell,search --label after
 *   pnpm exec tsx scripts/perf/surfaces-probe.ts --no-build --compare perf-report/surfaces-before.json
 *   pnpm exec tsx scripts/perf/surfaces-probe.ts --no-build --explore   # dump each surface's a11y tree
 *   pnpm exec tsx scripts/perf/surfaces-probe.ts --no-build --only org-comments --profile "org-comments / open"
 *                                                              # + where the blocked time went (self time by function)
 *   pnpm exec tsx scripts/perf/surfaces-probe.ts --no-build --only projects-list --why DataTable,OrgProjectsDataTable
 *                                                              # + which props changed identity each time those rendered
 *
 * A surface is a list of actions. Each action is one user gesture (a route
 * change, a click, a few keystrokes); the probe is reset before it and read
 * once the network has been quiet, so a row of the table is the full cost of
 * that gesture including the reads it triggers.
 *
 * The ranking is by what a user feels: blocked main-thread time at
 * `--throttle 4`, then commits, then routes sent more than once. Counts are
 * machine-independent; timings are indicative only.
 *
 * A second, larger fixture (`--handle .perf/surfaces-large.json`, seeded with
 * `--books 20 --cells 6000`) shows which costs grow with the project.
 */

import { parseArgs } from "node:util"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Locator, Page } from "@playwright/test"
import { devLogin, DEFAULT_TARGET, type PerfTarget } from "./lib/client"
import { readHandle, type BigBibleHandle } from "./lib/fixture-handle"
import {
  INTERACTION_INIT_SCRIPT,
  READ_PROBE,
  RESET_PROBE,
  routeKey,
  summarizePhase,
  type PhaseResult,
  type ProbeReading,
  type RequestTally,
} from "./lib/interaction-probe"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const DIST_DIR = path.join(REPO_ROOT, ".perf", "surfaces-dist")
const REPORT_DIR = path.join(REPO_ROOT, "perf-report")
const EXPLORE_DIR = path.join(REPO_ROOT, ".perf", "surfaces-explore")
const PREVIEW_PORT = 4180
const CLOUD_CHROMIUM = "/opt/pw-browsers/chromium"
/** Stall watchdogs, not targets (AGENTS.md rule 15). */
const READY_TIMEOUT_MS = 60_000
const STEP_TIMEOUT_MS = 20_000

interface Options {
  handlePath: string
  throttle: number
  build: boolean
  appBase: string | null
  only: string[] | null
  label: string
  compare: string | null
  explore: boolean
  /** Capture a CPU profile for actions whose "surface / action" contains this. */
  profile: string | null
  /** Component names to explain: which props changed identity when they rendered. */
  why: string[]
  target: PerfTarget
}

function parseOptions(argv: string[]): Options {
  const { values } = parseArgs({
    args: argv,
    options: {
      handle: { type: "string" },
      throttle: { type: "string" },
      "no-build": { type: "boolean" },
      "app-base": { type: "string" },
      only: { type: "string" },
      label: { type: "string" },
      compare: { type: "string" },
      explore: { type: "boolean" },
      profile: { type: "string" },
      why: { type: "string" },
    },
  })
  const throttle = Number(values.throttle ?? 4)
  if (!Number.isFinite(throttle) || throttle < 1) throw new Error("--throttle must be a number >= 1")
  return {
    handlePath: values.handle ?? path.join(REPO_ROOT, ".perf", "surfaces.json"),
    throttle,
    build: !values["no-build"],
    appBase: values["app-base"] ?? null,
    only: values.only?.split(",").map((s) => s.trim()).filter(Boolean) ?? null,
    label: values.label ?? "latest",
    compare: values.compare ?? null,
    explore: !!values.explore,
    profile: values.profile ?? null,
    why: values.why?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
    target: DEFAULT_TARGET,
  }
}

const log = (line: string) => console.log(`[surfaces] ${line}`)

// ── build + serve (same recipe as interaction.ts; that file runs on import) ──

function buildApp(target: PerfTarget): void {
  log("building the SPA (production, unminified) → .perf/surfaces-dist")
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

async function signIn(page: Page, appBase: string, target: PerfTarget): Promise<string> {
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
  return session.jwt
}

async function orgIdOfProject(target: PerfTarget, jwt: string, projectId: string): Promise<number> {
  const res = await fetch(`${target.authBase}/api/v2/projects`, { headers: { authorization: `Bearer ${jwt}` } })
  if (!res.ok) throw new Error(`GET /api/v2/projects failed: ${res.status}`)
  const body = (await res.json()) as { projects: Array<{ id: string; orgId: number }> }
  const row = body.projects.find((p) => p.id === projectId)
  if (!row) throw new Error(`the fixture project ${projectId} is not visible to the dev user — reseed`)
  return row.orgId
}

// ── why did it render ──────────────────────────────────────────────────────

/**
 * For the named components, count which props changed identity each time one
 * of them rendered: "(mount)", a prop name, or "(no prop changed)" — the last
 * meaning its own state or a context moved, or a parent re-rendered it with
 * equal props. Layered over the interaction probe's commit hook, so it must be
 * installed after it. This is how "the rows re-render on every keystroke"
 * becomes "because `renderRow` is a new function every time".
 */
function whyRenderScript(names: string[]): string {
  return `
(() => {
  const names = new Set(${JSON.stringify(names)});
  const why = (window.__whyRender = {});
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || names.size === 0) return;
  const fnName = (t) => {
    for (let depth = 0; depth < 4 && t; depth++) {
      if (typeof t === 'function') return t.displayName || t.name || 'Anonymous';
      if (typeof t !== 'object') return null;
      if (t.displayName) return t.displayName;
      t = t.render || t.type;
    }
    return null;
  };
  const bump = (rec, key) => { rec[key] = (rec[key] || 0) + 1; };
  const walk = (f) => {
    while (f) {
      const a = f.alternate;
      if ((f.flags & 1) && (f.tag === 0 || f.tag === 11 || f.tag === 14 || f.tag === 15)) {
        const n = fnName(f.type);
        if (n && names.has(n)) {
          const rec = (why[n] = why[n] || {});
          if (!a) bump(rec, '(mount)');
          else {
            const p = f.memoizedProps || {}, q = a.memoizedProps || {};
            let any = false;
            for (const k of new Set([...Object.keys(p), ...Object.keys(q)])) {
              if (p[k] !== q[k]) { bump(rec, k); any = true; }
            }
            if (!any) bump(rec, '(no prop changed)');
          }
        }
      }
      if (f.child && (!a || f.child !== a.child)) walk(f.child);
      f = f.sibling;
    }
  };
  const prev = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function (id, root) {
    try { walk(root.current); } catch {}
    return prev.apply(this, arguments);
  };
})();
`
}

const RESET_WHY = "(() => { const w = window.__whyRender; if (w) for (const k of Object.keys(w)) delete w[k]; })()"
const READ_WHY = "window.__whyRender || {}"

// ── recorder ───────────────────────────────────────────────────────────────

/** A phase plus every request it sent, in order, with the query string. */
type SurfacePhase = PhaseResult & { urls: string[] }

interface Recorder {
  begin(): Promise<void>
  end(name: string, extra?: Record<string, number>): Promise<SurfacePhase>
}

function createRecorder(page: Page, appOrigin: string): Recorder {
  let started: Array<{ route: string; url: string; request: unknown }> = []
  const sizes = new Map<unknown, number>()
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.origin === appOrigin) return // the app's own static assets
    if (url.protocol !== "http:" && url.protocol !== "https:") return
    started.push({ route: routeKey(request.method(), url.pathname), url: `${request.method()} ${url.pathname}${url.search}`, request })
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
    async end(name, extra = {}) {
      await settleQuiet(1_500, 30_000)
      const reading = (await page.evaluate(READ_PROBE)) as ProbeReading
      if (reading.react.error) throw new Error(`render counter failed: ${reading.react.error}`)
      const tally: RequestTally = { count: started.length, bytes: 0, byRoute: {} }
      for (const entry of started) {
        tally.bytes += sizes.get(entry.request) ?? 0
        tally.byRoute[entry.route] = (tally.byRoute[entry.route] ?? 0) + 1
      }
      return { ...summarizePhase(name, reading, tally, extra), urls: started.map((entry) => entry.url) }
    },
  }
}

// ── scenarios ──────────────────────────────────────────────────────────────

interface Ctx {
  page: Page
  appBase: string
  handle: BigBibleHandle
  orgId: number
  /** Client-side navigation, as a `<Link>` click does it: no reload. */
  spa(pathname: string): Promise<void>
  /** A full page load. */
  load(pathname: string): Promise<void>
  visible(locator: Locator): Promise<void>
}

interface Action {
  name: string
  run(ctx: Ctx): Promise<void>
}

interface Surface {
  name: string
  actions: Action[]
}

const button = (page: Page, name: string | RegExp) => page.getByRole("button", { name }).first()

/**
 * Nobody touches anything for six seconds. A screen at rest should commit
 * nothing: a count here is a ticker or a poll re-rendering the page for as
 * long as it stays open.
 */
const idle = (where: string): Action => ({
  name: `idle 6 s (${where})`,
  run: async ({ page }) => {
    await page.waitForTimeout(6_000)
  },
})

function surfaces(ctx: Ctx): Surface[] {
  const { page, handle, orgId } = ctx
  const project = handle.projectId
  const file0 = handle.files[0]
  const file1 = handle.files[1] ?? handle.files[0]
  const row = page.locator("[data-cell-id]").first()
  const main = page.getByRole("main").first()
  const heading = (name: string | RegExp) => page.getByRole("heading", { name }).first()
  const dialog = page.getByRole("dialog").first()
  const searchBox = page.getByPlaceholder(/^Search /).first()
  const closeDialog = async () => {
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS })
  }
  const openRowMenu = async () => {
    const target = page.locator("[data-cell-id]").nth(3)
    await target.hover({ timeout: STEP_TIMEOUT_MS })
    await target.getByRole("button", { name: /^More actions/ }).first().click({ timeout: STEP_TIMEOUT_MS })
    await ctx.visible(page.getByRole("button", { name: "Edit history" }).first())
  }

  return [
    {
      name: "first-load",
      actions: [
        {
          name: "cold load /app → home",
          run: async () => {
            await ctx.load("/app")
            await page.waitForURL(/\/orgs\//, { timeout: READY_TIMEOUT_MS })
            await ctx.visible(main)
          },
        },
      ],
    },
    {
      name: "shell",
      actions: [
        { name: "route → org projects", run: async () => { await ctx.spa(`/orgs/${orgId}/projects`); await ctx.visible(page.getByTestId("project-table-name").first()) } },
        { name: "route → org overview", run: async () => { await ctx.spa(`/orgs/${orgId}/overview`); await ctx.visible(main) } },
        { name: "route → org projects (warm)", run: async () => { await ctx.spa(`/orgs/${orgId}/projects`); await ctx.visible(page.getByTestId("project-table-name").first()) } },
        {
          name: "open + close org switcher",
          run: async () => {
            const switcher = page.getByRole("combobox", { name: /^Organization switcher:/i }).first()
            await switcher.click({ timeout: STEP_TIMEOUT_MS })
            await page.waitForTimeout(400)
            await page.keyboard.press("Escape")
          },
        },
        {
          name: "open + close account menu",
          run: async () => {
            await page.locator('[data-account-switcher-surface="sidebar"]').first().click({ timeout: STEP_TIMEOUT_MS })
            await ctx.visible(page.getByRole("menu").first())
            await page.keyboard.press("Escape")
          },
        },
      ],
    },
    {
      name: "projects-list",
      actions: [
        { name: "open", run: async () => { await ctx.spa(`/orgs/${orgId}/overview`); await ctx.spa(`/orgs/${orgId}/projects`); await ctx.visible(page.getByTestId("project-table-name").first()) } },
        {
          name: "type 4 chars in the project filter",
          run: async () => {
            const box = page.getByRole("searchbox").or(page.getByPlaceholder(/search|filter/i)).first()
            await box.click({ timeout: STEP_TIMEOUT_MS })
            await page.keyboard.type("perf", { delay: 60 })
          },
        },
        {
          name: "clear the project filter",
          run: async () => {
            const box = page.getByRole("searchbox").or(page.getByPlaceholder(/search|filter/i)).first()
            await box.fill("", { timeout: STEP_TIMEOUT_MS })
          },
        },
      ],
    },
    {
      name: "org-home-all",
      actions: [{ name: "open /orgs/all", run: async () => { await ctx.spa("/orgs/all"); await ctx.visible(main) } }],
    },
    {
      name: "org-members",
      actions: [
        { name: "open", run: async () => { await ctx.spa(`/orgs/${orgId}/members`); await ctx.visible(heading(/members|people/i)) } },
        { name: "switch to matrix", run: async () => { await ctx.spa(`/orgs/${orgId}/members/matrix`); await page.waitForTimeout(300) } },
      ],
    },
    {
      name: "org-settings",
      actions: [
        { name: "open", run: async () => { await ctx.spa(`/orgs/${orgId}/settings`); await ctx.visible(main) } },
        { name: "section → security", run: async () => { await ctx.spa(`/orgs/${orgId}/settings/security`); await page.waitForTimeout(300) } },
        { name: "section → rules", run: async () => { await ctx.spa(`/orgs/${orgId}/settings/rules`); await page.waitForTimeout(300) } },
        { name: "section → project defaults", run: async () => { await ctx.spa(`/orgs/${orgId}/settings/project-defaults`); await page.waitForTimeout(300) } },
      ],
    },
    {
      name: "org-comments",
      actions: [{ name: "open", run: async () => { await ctx.spa(`/orgs/${orgId}/comments`); await ctx.visible(main) } }],
    },
    {
      name: "project-overview",
      actions: [
        { name: "open", run: async () => { await ctx.spa(`/projects/${project}`); await ctx.visible(button(page, /^Open project$/i)) } },
        idle("project overview"),
        { name: "open in-place project settings dialog", run: async () => { await page.getByTestId("overview-project-settings").first().click({ timeout: STEP_TIMEOUT_MS }); await ctx.visible(page.getByTestId("project-settings-dialog").first()) } },
        { name: "close project settings dialog", run: async () => { await page.keyboard.press("Escape"); await page.getByTestId("project-settings-dialog").first().waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }) } },
      ],
    },
    {
      name: "project-settings",
      actions: [
        { name: "open (page)", run: async () => { await ctx.spa(`/project/${project}/settings`); await ctx.visible(main) } },
        { name: "section → members", run: async () => { await ctx.spa(`/project/${project}/settings/members`); await page.waitForTimeout(300) } },
        { name: "section → languages", run: async () => { await ctx.spa(`/project/${project}/settings/languages`); await page.waitForTimeout(300) } },
        { name: "section → general", run: async () => { await ctx.spa(`/project/${project}/settings/general`); await page.waitForTimeout(300) } },
      ],
    },
    {
      name: "workspace",
      actions: [
        { name: "open file (route change)", run: async () => { await ctx.spa(`/project/${project}/editor/file/${file0.id}`); await ctx.visible(row) } },
        { name: "switch file", run: async () => { await ctx.spa(`/project/${project}/editor/file/${file1.id}`); await ctx.visible(row); await page.waitForTimeout(500) } },
        { name: "switch file back (warm)", run: async () => { await ctx.spa(`/project/${project}/editor/file/${file0.id}`); await ctx.visible(row); await page.waitForTimeout(500) } },
        idle("editor open, no cell active"),
      ],
    },
    {
      name: "import-dialog",
      actions: [
        {
          name: "open",
          run: async () => {
            await page.getByRole("banner").getByRole("button", { name: /^Import$/i }).first().click({ timeout: STEP_TIMEOUT_MS })
            await ctx.visible(dialog)
          },
        },
        {
          name: "pick a file → preview",
          run: async () => {
            const lines = Array.from({ length: 200 }, (_, i) => `Probe sentence number ${i}.`).join("\n")
            await dialog.getByRole("button", { name: /^Upload files/ }).first().click({ timeout: STEP_TIMEOUT_MS })
            await dialog.locator('input[type="file"]').first().setInputFiles(
              { name: "probe.txt", mimeType: "text/plain", buffer: Buffer.from(lines) },
              { timeout: STEP_TIMEOUT_MS },
            )
            await ctx.visible(button(page, /Confirm import/i))
          },
        },
        { name: "close", run: async () => { await closeDialog() } },
      ],
    },
    {
      name: "export-dialog",
      actions: [
        {
          // From the OPEN file's own menu: another file's menu switches to that
          // file first, and the row would then be a file switch plus a dialog.
          name: "open (the open file's menu → Export)",
          run: async () => {
            const openFile = page.locator('aside [data-showcase="sidebar.file"]').filter({ hasText: file0.name }).first()
            await openFile.getByRole("button", { name: "File actions" }).first().click({ timeout: STEP_TIMEOUT_MS })
            await page.getByRole("menuitem", { name: /^Export/i }).first().click({ timeout: STEP_TIMEOUT_MS })
            await ctx.visible(dialog)
          },
        },
        { name: "close", run: async () => { await closeDialog() } },
      ],
    },
    {
      name: "search",
      actions: [
        { name: "open the search dock", run: async () => { await page.getByRole("complementary").getByRole("button", { name: "Search", exact: true }).first().click({ timeout: STEP_TIMEOUT_MS }); await ctx.visible(searchBox) } },
        { name: "type a 5-char query", run: async () => { await searchBox.click({ timeout: STEP_TIMEOUT_MS }); await page.keyboard.type("light", { delay: 80 }) } },
        { name: "extend the query by 3 chars", run: async () => { await page.keyboard.type(" of", { delay: 80 }) } },
        { name: "back to the files dock", run: async () => { await page.getByRole("complementary").getByRole("button", { name: "Files", exact: true }).first().click({ timeout: STEP_TIMEOUT_MS }); await page.waitForTimeout(300) } },
      ],
    },
    {
      name: "comments-panel",
      actions: [
        { name: "open (row menu → Add comment)", run: async () => { await openRowMenu(); await page.getByRole("button", { name: "Add comment" }).first().click({ timeout: STEP_TIMEOUT_MS }); await page.waitForTimeout(400) } },
        { name: "close", run: async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(400) } },
      ],
    },
    {
      name: "history-panel",
      actions: [
        { name: "open (row menu → Edit history)", run: async () => { await openRowMenu(); await page.getByRole("button", { name: "Edit history" }).first().click({ timeout: STEP_TIMEOUT_MS }); await page.waitForTimeout(400) } },
        { name: "close", run: async () => { await page.keyboard.press("Escape"); await page.waitForTimeout(400) } },
      ],
    },
    {
      name: "timeline-lens",
      actions: [
        { name: "open (Media tab)", run: async () => { await page.getByRole("main").getByRole("tab", { name: "Media", exact: true }).first().click({ timeout: STEP_TIMEOUT_MS }); await page.waitForTimeout(800) } },
        { name: "back to Text", run: async () => { await page.getByRole("main").getByRole("tab", { name: "Text", exact: true }).first().click({ timeout: STEP_TIMEOUT_MS }); await ctx.visible(row) } },
      ],
    },
    {
      name: "comments-page",
      actions: [
        { name: "open", run: async () => { await ctx.spa(`/project/${project}/comments`); await page.waitForTimeout(500) } },
        { name: "back to editor", run: async () => { await ctx.spa(`/project/${project}/editor/file/${file0.id}`); await ctx.visible(row) } },
      ],
    },
    {
      name: "glossary-page",
      actions: [
        { name: "open", run: async () => { await ctx.spa(`/project/${project}/terminology`); await ctx.visible(heading("Terminology")) } },
        { name: "open the Add term dialog", run: async () => { await button(page, "Add term").click({ timeout: STEP_TIMEOUT_MS }); await ctx.visible(dialog) } },
        { name: "type 8 chars in the Add term dialog", run: async () => { await dialog.getByPlaceholder("New source term…").click({ timeout: STEP_TIMEOUT_MS }); await page.keyboard.type("covenant", { delay: 60 }) } },
        { name: "close the Add term dialog", run: async () => { await closeDialog() } },
        {
          // Only on a fixture that has terms (the interaction benchmark's glossary variant).
          name: "expand a term's renderings",
          run: async () => {
            const expand = page.getByRole("button", { name: "Expand renderings" }).first()
            if (!(await expand.isVisible().catch(() => false))) throw new Error("the fixture has no glossary terms")
            await expand.click({ timeout: STEP_TIMEOUT_MS })
            await ctx.visible(page.getByRole("button", { name: "Collapse renderings" }).first())
          },
        },
      ],
    },
    {
      name: "living-memory",
      actions: [
        { name: "open", run: async () => { await ctx.spa(`/project/${project}/memory`); await ctx.visible(heading("Living Memory")) } },
        { name: "section → quality (rules)", run: async () => { await ctx.spa(`/project/${project}/memory/quality`); await page.waitForTimeout(400) } },
        idle("quality section"),
        { name: "section → brief", run: async () => { await ctx.spa(`/project/${project}/memory/brief`); await page.waitForTimeout(400) } },
        { name: "section → style", run: async () => { await ctx.spa(`/project/${project}/memory/style`); await page.waitForTimeout(400) } },
      ],
    },
    {
      name: "voice-studio",
      actions: [
        { name: "open", run: async () => { await ctx.spa(`/project/${project}/voice`); await page.waitForTimeout(500) } },
        {
          // The studio is the Media lens, and the editor can come back still
          // in it (the lens is a remembered preference): return to Text.
          name: "back to the text editor",
          run: async () => {
            await ctx.spa(`/project/${project}/editor/file/${file0.id}`)
            const text = page.getByRole("main").getByRole("tab", { name: "Text", exact: true }).first()
            await ctx.visible(text)
            if ((await text.getAttribute("aria-selected")) !== "true") await text.click({ timeout: STEP_TIMEOUT_MS })
            await ctx.visible(row)
          },
        },
      ],
    },
    {
      name: "preferences",
      actions: [
        { name: "open (page)", run: async () => { await ctx.spa("/preferences"); await ctx.visible(main) } },
        { name: "back to projects list", run: async () => { await ctx.spa(`/orgs/${orgId}/projects`); await ctx.visible(page.getByTestId("project-table-name").first()) } },
      ],
    },
    {
      name: "login",
      actions: [
        {
          // Last: it signs the browser out.
          name: "cold load /login (signed out)",
          run: async () => {
            await page.evaluate(`new Promise((res) => { const r = indexedDB.deleteDatabase("frontier"); r.onsuccess = r.onerror = r.onblocked = () => res(null); })`)
            await ctx.load("/login")
            await ctx.visible(page.getByRole("button", { name: /log in|sign in|continue/i }).first())
          },
        },
      ],
    },
  ]
}

// ── run ────────────────────────────────────────────────────────────────────

interface Row {
  surface: string
  action: string
  ms: number
  phase: SurfacePhase | null
  error: string | null
  why?: Record<string, Record<string, number>>
}

interface Report {
  harness: "surfaces"
  label: string
  sha: string
  at: string
  throttle: number
  fixture: BigBibleHandle["stats"]
  rows: Row[]
}

async function measure(appBase: string, handle: BigBibleHandle, options: Options): Promise<Row[]> {
  const { chromium } = await import("@playwright/test")
  // A cloud session ships its own Chromium, not the one this lockfile pins.
  const chrome = process.env.PERF_CHROME ?? (existsSync(CLOUD_CHROMIUM) ? CLOUD_CHROMIUM : null)
  const browser = await chromium.launch(chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : {})
  const rows: Row[] = []
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.addInitScript({ content: INTERACTION_INIT_SCRIPT })
    if (options.why.length > 0) await context.addInitScript({ content: whyRenderScript(options.why) })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    const recorder = createRecorder(page, new URL(appBase).origin)
    const jwt = await signIn(page, appBase, options.target)
    const orgId = await orgIdOfProject(options.target, jwt, handle.projectId)
    if (options.throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.throttle })

    const ctx: Ctx = {
      page,
      appBase,
      handle,
      orgId,
      async spa(pathname) {
        await page.evaluate(`(() => { history.pushState(null, "", ${JSON.stringify(pathname)}); dispatchEvent(new PopStateEvent("popstate", { state: null })); })()`)
      },
      async load(pathname) {
        await page.goto(`${appBase}${pathname}`, { waitUntil: "commit", timeout: READY_TIMEOUT_MS })
      },
      async visible(locator) {
        await locator.waitFor({ state: "visible", timeout: READY_TIMEOUT_MS })
      },
    }

    // Boot once so `only` runs start from a signed-in, loaded shell.
    await ctx.load("/app")
    await page.waitForURL(/\/orgs\//, { timeout: READY_TIMEOUT_MS })
    await recorder.begin()
    await recorder.end("boot")

    const needsWorkspace = new Set(["import-dialog", "export-dialog", "search", "comments-panel", "history-panel", "timeline-lens"])
    for (const surface of surfaces(ctx)) {
      if (options.only && !options.only.includes(surface.name)) continue
      if (needsWorkspace.has(surface.name) && !/\/editor\/file\//.test(page.url())) {
        await ctx.spa(`/project/${handle.projectId}/editor/file/${handle.files[0].id}`)
        await ctx.visible(page.locator("[data-cell-id]").first())
        await recorder.begin()
        await recorder.end("settle")
      }
      for (const action of surface.actions) {
        const entry: Row = { surface: surface.name, action: action.name, ms: 0, phase: null, error: null }
        const label = `${surface.name} / ${action.name}`
        const profiling = options.profile != null && label.includes(options.profile)
        try {
          await recorder.begin()
          if (options.why.length > 0) await page.evaluate(RESET_WHY)
          if (profiling) {
            await cdp.send("Profiler.enable")
            await cdp.send("Profiler.start")
          }
          const t0 = Date.now()
          await action.run(ctx)
          entry.ms = Date.now() - t0
          entry.phase = await recorder.end(label, { ms: entry.ms })
          if (profiling) {
            const { profile } = (await cdp.send("Profiler.stop")) as { profile: CpuProfile }
            console.log(renderSelfTime(label, profile))
          }
          if (options.why.length > 0) {
            entry.why = (await page.evaluate(READ_WHY)) as Record<string, Record<string, number>>
            for (const [name, reasons] of Object.entries(entry.why)) {
              const parts = Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([key, n]) => `${key}×${n}`)
              log(`  why ${name}: ${parts.join(", ")}`)
            }
          }
          log(
            `${surface.name} / ${action.name}: ${entry.phase.longTaskTotalMs}ms blocked, ${entry.phase.reactCommits} commits, `
              + `${entry.phase.componentRenders} renders, ${entry.phase.requests.count} requests`,
          )
        } catch (error) {
          entry.error = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 300)
          log(`${surface.name} / ${action.name}: FAILED — ${entry.error}`)
          await page.keyboard.press("Escape").catch(() => {})
        }
        rows.push(entry)
        if (options.explore) {
          mkdirSync(EXPLORE_DIR, { recursive: true })
          const tree = await page.locator("body").ariaSnapshot().catch((error: unknown) => `ariaSnapshot failed: ${String(error)}`)
          const slug = `${surface.name}--${surface.actions.indexOf(action)}`
          writeFileSync(path.join(EXPLORE_DIR, `${slug}.yml`), `# ${action.name} — ${page.url()}\n${tree}\n`)
        }
      }
    }
  } finally {
    await browser.close()
  }
  return rows
}

// ── cpu profile ────────────────────────────────────────────────────────────

interface CpuProfile {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>
  samples?: number[]
  timeDeltas?: number[]
}

/** Self time by function, highest first — where a long task actually went. */
function renderSelfTime(label: string, profile: CpuProfile, top = 30): string {
  const frames = new Map(profile.nodes.map((node) => [node.id, node.callFrame]))
  const selfUs = new Map<string, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) {
    const frame = frames.get(samples[i])
    if (!frame) continue
    const file = frame.url.split("/").pop()?.split("?")[0] ?? ""
    const key = `${frame.functionName || "(anonymous)"} ${file}:${frame.lineNumber + 1}`
    selfUs.set(key, (selfUs.get(key) ?? 0) + (deltas[i] ?? 0))
  }
  const rowsOut = [...selfUs.entries()]
    .filter(([key]) => !key.startsWith("(idle)") && !key.startsWith("(program)"))
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
  return [`\n[surfaces] CPU self time — ${label}`, ...rowsOut.map(([key, us]) => `  ${String(Math.round(us / 1000)).padStart(6)}ms  ${key}`), ""].join("\n")
}

// ── report ─────────────────────────────────────────────────────────────────

const repeated = (phase: PhaseResult) => Object.values(phase.repeatedRoutes).reduce((sum, n) => sum + (n - 1), 0)

/** Blocked time first, then commits, then duplicate requests. */
function ranked(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    if (!a.phase || !b.phase) return a.phase ? -1 : b.phase ? 1 : 0
    return (
      b.phase.longTaskTotalMs - a.phase.longTaskTotalMs
      || b.phase.reactCommits - a.phase.reactCommits
      || repeated(b.phase) - repeated(a.phase)
    )
  })
}

function renderTable(rows: Row[], before: Map<string, Row> | null): string {
  const lines: string[] = []
  const cell = (value: string | number, width: number) => String(value).padEnd(width)
  const delta = (key: string, now: number, pick: (phase: PhaseResult) => number) => {
    const prior = before?.get(key)?.phase
    return prior ? `${pick(prior)}→${now}` : String(now)
  }
  lines.push(
    `${cell("surface / action", 58)}${cell("blocked ms", 14)}${cell("longest", 9)}${cell("commits", 12)}${cell("renders", 16)}${cell("reqs", 9)}repeated routes`,
  )
  for (const row of ranked(rows)) {
    const key = `${row.surface} / ${row.action}`
    if (!row.phase) {
      lines.push(`${cell(key, 58)}not measured: ${row.error}`)
      continue
    }
    const p = row.phase
    const dupes = Object.entries(p.repeatedRoutes).map(([route, n]) => `${route} ×${n}`).join("; ")
    lines.push(
      cell(key, 58)
        + cell(delta(key, p.longTaskTotalMs, (x) => x.longTaskTotalMs), 14)
        + cell(p.longestTaskMs, 9)
        + cell(delta(key, p.reactCommits, (x) => x.reactCommits), 12)
        + cell(delta(key, p.componentRenders, (x) => x.componentRenders), 16)
        + cell(delta(key, p.requests.count, (x) => x.requests.count), 9)
        + dupes,
    )
  }
  return lines.join("\n")
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const handle = readHandle(options.handlePath)
  let stopPreview: (() => void) | null = null
  let appBase = options.appBase
  try {
    if (!appBase) {
      if (options.build || !existsSync(path.join(DIST_DIR, "index.html"))) buildApp(options.target)
      const preview = await servePreview()
      appBase = preview.base
      stopPreview = preview.stop
    }
    const rows = await measure(appBase, handle, options)
    const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).stdout.trim()
    const report: Report = {
      harness: "surfaces",
      label: options.label,
      sha,
      at: new Date().toISOString(),
      throttle: options.throttle,
      fixture: handle.stats,
      rows,
    }
    mkdirSync(REPORT_DIR, { recursive: true })
    const file = path.join(REPORT_DIR, `surfaces-${options.label}.json`)
    writeFileSync(file, JSON.stringify(report, null, 2))
    log(`report → ${path.relative(REPO_ROOT, file)}`)

    let before: Map<string, Row> | null = null
    if (options.compare) {
      const prior = JSON.parse(readFileSync(path.resolve(options.compare), "utf8")) as Report
      before = new Map(prior.rows.map((row) => [`${row.surface} / ${row.action}`, row]))
    }
    console.log("")
    console.log(renderTable(rows, before))
    console.log("")
  } finally {
    stopPreview?.()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exit(1)
})
