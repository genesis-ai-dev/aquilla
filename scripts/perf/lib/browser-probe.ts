/**
 * Main-thread probe for the AQU-1868 harness: open a screen of the real SPA
 * against the seeded Big Bible project and report how long it took to become
 * usable, plus the long tasks (>50ms) the main thread ran getting there.
 *
 * Long-task count is the number the editor and rules tickets are really about.
 * A screen can "load in 2 seconds" and still be unusable because that time was
 * one 1,800ms task that blocked every keystroke; the same 2 seconds spread
 * over forty short tasks types fine. So both are measured, and both are
 * budgeted.
 *
 * Playwright is imported dynamically: the HTTP half of `measure.ts` must run
 * on a box with no browser installed.
 *
 * Readiness selectors are defaults, not truths — the harness prints what it
 * waited for and both are overridable (`--editor-ready`, `--rules-ready`), so
 * a UI change costs a flag rather than a wrong number.
 */

export interface ScreenProbe {
  name: string
  url: string
  /** Time from navigation start to the readiness selector being visible. */
  readyMs: number
  readySelector: string
  longTaskCount: number
  longTaskTotalMs: number
  longestTaskMs: number
}

export interface BrowserProbeOptions {
  /** Vite origin of the running SPA — e.g. http://127.0.0.1:5173. */
  appBase: string
  projectId: string
  /** File to open in the editor. */
  fileId: string
  editorReadySelector: string
  rulesReadySelector: string
  /** Stall watchdog for one screen. Generous on purpose (AGENTS.md rule 15). */
  timeoutMs: number
  /** Settle window after readiness, so late long tasks are still counted. */
  settleMs: number
  log?: (line: string) => void
}

/**
 * Installed before any app code runs. Collects `longtask` entries into
 * `window.__perfLongTasks`; `__perfResetLongTasks()` clears them between
 * screens. Written as a string so this file needs no DOM lib — the scripts
 * tsconfig is Node-only.
 */
const LONG_TASK_INIT_SCRIPT = `
  (() => {
    const store = [];
    window.__perfLongTasks = store;
    window.__perfResetLongTasks = () => { store.length = 0; };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) store.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      window.__perfLongTaskObserverUnsupported = true;
    }
  })();
`

const READ_LONG_TASKS = `
  (() => {
    const store = window.__perfLongTasks || [];
    return {
      count: store.length,
      totalMs: store.reduce((sum, ms) => sum + ms, 0),
      longestMs: store.reduce((max, ms) => (ms > max ? ms : max), 0),
      unsupported: !!window.__perfLongTaskObserverUnsupported,
    };
  })()
`

interface LongTaskReading {
  count: number
  totalMs: number
  longestMs: number
  unsupported: boolean
}

/**
 * Drive the editor and the project rules screen. Returns one probe per screen.
 * Throws with the page's URL and visible heading when a screen never becomes
 * ready — a bare timeout does not say which screen or why.
 */
export async function probeScreens(options: BrowserProbeOptions): Promise<ScreenProbe[]> {
  const log = options.log ?? (() => {})
  const { chromium } = await import("@playwright/test")
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript({ content: LONG_TASK_INIT_SCRIPT })
  const page = await context.newPage()
  const probes: ScreenProbe[] = []

  try {
    // Dev-stack auth bypass — the same `/__dev/login` the i18n shots use. It
    // lands on the seeded dev project; we navigate away from there next.
    await page.goto(`${options.appBase}/__dev/login`, { timeout: options.timeoutMs })
    await page.waitForURL(/\/project\//, { timeout: options.timeoutMs })

    const screens: Array<{ name: string; path: string; selector: string }> = [
      {
        name: "editor.open",
        path: `/project/${options.projectId}/editor/file/${options.fileId}`,
        selector: options.editorReadySelector,
      },
      {
        name: "rules.open",
        path: `/project/${options.projectId}/rules`,
        selector: options.rulesReadySelector,
      },
    ]

    for (const screen of screens) {
      await page.evaluate("window.__perfResetLongTasks && window.__perfResetLongTasks()")
      const url = `${options.appBase}${screen.path}`
      log(`[perf] opening ${screen.name} — ${url}`)
      const started = Date.now()
      await page.goto(url, { timeout: options.timeoutMs })
      try {
        await page.locator(screen.selector).first().waitFor({
          state: "visible",
          timeout: options.timeoutMs,
        })
      } catch (error) {
        const heading = await page
          .locator("h1, h2")
          .first()
          .textContent({ timeout: 2_000 })
          .catch(() => null)
        throw new Error(
          `${screen.name} never became ready: "${screen.selector}" did not appear within `
            + `${options.timeoutMs}ms at ${page.url()} (heading: ${heading ?? "none"}). `
            + "If the UI moved, pass a current selector with --editor-ready / --rules-ready.",
          { cause: error },
        )
      }
      const readyMs = Date.now() - started
      // Long tasks often land just after the first paint; counting only up to
      // readiness would under-report the jank a user actually feels.
      await page.waitForTimeout(options.settleMs)
      const reading = (await page.evaluate(READ_LONG_TASKS)) as LongTaskReading
      if (reading.unsupported) {
        throw new Error(
          `${screen.name}: this browser reported no longtask PerformanceObserver support, so `
            + "long-task counts would be silently zero. Run the probe on Chromium.",
        )
      }
      probes.push({
        name: screen.name,
        url,
        readyMs,
        readySelector: screen.selector,
        longTaskCount: reading.count,
        longTaskTotalMs: Math.round(reading.totalMs),
        longestTaskMs: Math.round(reading.longestMs),
      })
    }
  } finally {
    await context.close()
    await browser.close()
  }
  return probes
}

/** Flat, budget-checkable metrics for the browser screens. */
export function browserMetrics(probes: readonly ScreenProbe[]): Record<string, number> {
  const metrics: Record<string, number> = {}
  for (const probe of probes) {
    metrics[`${probe.name}.readyMs`] = probe.readyMs
    metrics[`${probe.name}.longTaskCount`] = probe.longTaskCount
    metrics[`${probe.name}.longTaskTotalMs`] = probe.longTaskTotalMs
    metrics[`${probe.name}.longestTaskMs`] = probe.longestTaskMs
  }
  return metrics
}
