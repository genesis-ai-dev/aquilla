/**
 * In-page probe for the interaction benchmark (AQU-2654).
 *
 * The AQU-1868 harness measures how long a screen takes to open and how fast
 * the server answers. Neither number moves when a click takes 800ms, because
 * the cost of an interaction is not one slow function: it is the number of
 * React commits an action causes multiplied by how much of the tree each
 * commit renders. So this probe counts both, per action:
 *
 *   reactCommits      — how many times React committed
 *   componentRenders  — how many function components ran in those commits
 *   renders[name]     — the same, per component (needs an unminified build)
 *
 * Counts are the contract. They do not depend on the machine, so a budget on
 * them cannot flake on a slow runner (AGENTS.md rule 15). Timings (long tasks,
 * input-to-paint) are reported beside them and budgeted loosely.
 *
 * The render counter is a stand-in `__REACT_DEVTOOLS_GLOBAL_HOOK__`, installed
 * before any app code runs. React calls `onCommitFiberRoot` in production
 * builds too; the walk below is the one DevTools itself uses: a fiber whose
 * `child` pointer equals its alternate's bailed out, so its subtree is skipped.
 *
 * Everything here is a string or pure data, so the file needs no DOM lib —
 * the scripts tsconfig is Node-only.
 */

export const INTERACTION_INIT_SCRIPT = `
(() => {
  const s = { longTasks: [], events: [], frames: [], responses: [], react: { commits: 0, renders: {}, fibers: 0, log: [] } };
  window.__interactionProbe = s;
  const R = s.react;
  const fnName = (t) => {
    for (let depth = 0; depth < 4 && t; depth++) {
      if (typeof t === 'function') return t.displayName || t.name || 'Anonymous';
      if (typeof t !== 'object') return null;
      if (t.displayName) return t.displayName;
      t = t.render || t.type;
    }
    return null;
  };
  // tag 0 FunctionComponent, 11 ForwardRef, 14 MemoComponent, 15 SimpleMemoComponent.
  // \`top\` is the first component the walk meets that rendered: the highest
  // one in the tree, which is what scheduled (or inherited) this commit's work.
  let top = null;
  const walk = (f) => {
    while (f) {
      const a = f.alternate;
      if ((f.flags & 1) && (f.tag === 0 || f.tag === 11 || f.tag === 14 || f.tag === 15)) {
        const n = fnName(f.type) || 'Anonymous';
        R.renders[n] = (R.renders[n] || 0) + 1;
        R.fibers++;
        if (top === null) top = n;
      }
      if (f.child && (!a || f.child !== a.child)) walk(f.child);
      f = f.sibling;
    }
  };
  if (!window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, renderers: new Map(), inject() { return 1; }, checkDCE() {},
      onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, onScheduleFiberRoot() {},
      onCommitFiberRoot(_id, root) {
        try {
          const before = R.fibers;
          top = null;
          R.commits++;
          walk(root.current);
          R.log.push([Math.round(performance.now()), R.fibers - before, top]);
        } catch (e) { R.error = String(e); }
      },
    };
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) s.longTasks.push(e.duration);
    }).observe({ type: 'longtask', buffered: true });
  } catch { s.longTaskUnsupported = true; }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) s.events.push({ name: e.name, duration: e.duration, processing: e.processingEnd - e.processingStart });
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch {}
  // When each API response finished, to line up against the commit log. Same-origin
  // entries are the app's own static assets.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const u = new URL(e.name);
        if (u.origin !== location.origin) s.responses.push([Math.round(e.responseEnd), u.pathname]);
      }
    }).observe({ type: 'resource' });
  } catch {}
  // Input-to-paint: rAF runs before the frame is produced; the message task
  // posted from it runs after, which is the first moment the frame can be out.
  document.addEventListener('input', () => {
    const t = performance.now();
    requestAnimationFrame(() => {
      const c = new MessageChannel();
      c.port1.onmessage = () => s.frames.push(performance.now() - t);
      c.port2.postMessage(0);
    });
  }, true);
  s.reset = () => { s.responses.length = 0; s.longTasks.length = 0; s.events.length = 0; s.frames.length = 0; R.commits = 0; R.renders = {}; R.fibers = 0; R.log = []; };
})();
`

export const READ_PROBE = "(() => { const s = window.__interactionProbe; return { longTasks: s.longTasks, events: s.events, frames: s.frames, responses: s.responses, react: s.react, longTaskUnsupported: !!s.longTaskUnsupported }; })()"
export const RESET_PROBE = "window.__interactionProbe && window.__interactionProbe.reset()"

/** Make the page believe the tab was hidden, the way a real tab switch does. */
export const HIDE_TAB = `
(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('blur'));
})()
`

/**
 * Bring the tab back and watch the editor for `watchMs`: every frame records
 * how many cell rows are in the DOM, so a return that blanks the editor is a
 * number (frames with zero rows) rather than an impression.
 */
export function showTabScript(watchMs: number, rowSelector: string): string {
  return `
(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  const frames = []; window.__interactionRowFrames = frames;
  const t0 = performance.now();
  const tick = () => {
    frames.push(document.querySelectorAll(${JSON.stringify(rowSelector)}).length);
    if (performance.now() - t0 < ${watchMs}) requestAnimationFrame(tick);
  };
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event('focus'));
  tick();
})()
`
}

export interface ProbeReading {
  longTasks: number[]
  events: Array<{ name: string; duration: number; processing: number }>
  frames: number[]
  /** [performance.now() ms the response finished, URL path] for every cross-origin request. */
  responses: Array<[number, string]>
  react: {
    commits: number
    renders: Record<string, number>
    fibers: number
    /** One entry per commit: [performance.now() ms, components rendered, topmost component rendered]. */
    log: Array<[number, number, string | null]>
    error?: string
  }
  longTaskUnsupported: boolean
}

export interface RequestTally {
  count: number
  bytes: number
  /** `METHOD /path/with/:id` → how many times it was sent. */
  byRoute: Record<string, number>
}

export interface PhaseResult {
  name: string
  reactCommits: number
  componentRenders: number
  /** The components that rendered most, highest first. */
  topRenders: Array<[string, number]>
  /**
   * Every commit in order: [ms after the phase's first commit, components rendered, the
   * topmost component that rendered]. Diff two runs' timelines to see which commits a
   * timing-dependent count gained or lost.
   */
  commitLog: Array<[number, number, string | null]>
  /** API responses on the same clock as `commitLog`: [ms after the phase's first commit, route]. */
  responseLog: Array<[number, string]>
  longTaskCount: number
  longTaskTotalMs: number
  longestTaskMs: number
  inputToPaintP95Ms: number | null
  slowestEvent: string | null
  requests: RequestTally
  /** Routes sent more than once in this phase — the duplicate-read tell. */
  repeatedRoutes: Record<string, number>
  extra: Record<string, number>
}

function p95(samples: readonly number[]): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] * 10) / 10
}

/** How often named components rendered — 0 when absent or names are minified. */
export function rendersOf(reading: ProbeReading, ...names: string[]): number {
  return names.reduce((sum, name) => sum + (reading.react.renders[name] ?? 0), 0)
}

export function summarizePhase(
  name: string,
  reading: ProbeReading,
  requests: RequestTally,
  extra: Record<string, number> = {},
): PhaseResult {
  const t0 = reading.react.log[0]?.[0] ?? 0
  const slowest = [...reading.events].sort((a, b) => b.duration - a.duration)[0]
  const repeatedRoutes: Record<string, number> = {}
  for (const [route, count] of Object.entries(requests.byRoute)) {
    if (count > 1) repeatedRoutes[route] = count
  }
  return {
    name,
    reactCommits: reading.react.commits,
    componentRenders: reading.react.fibers,
    topRenders: Object.entries(reading.react.renders).sort((a, b) => b[1] - a[1]).slice(0, 25),
    commitLog: reading.react.log.map(([t, fibers, top]) => [t - t0, fibers, top]),
    responseLog: reading.responses.map(([t, pathname]) => [t - t0, routeKey("GET", pathname).slice(4)]),
    longTaskCount: reading.longTasks.length,
    longTaskTotalMs: Math.round(reading.longTasks.reduce((sum, ms) => sum + ms, 0)),
    longestTaskMs: Math.round(reading.longTasks.reduce((max, ms) => (ms > max ? ms : max), 0)),
    inputToPaintP95Ms: p95(reading.frames),
    slowestEvent: slowest ? `${slowest.name} ${Math.round(slowest.duration)}ms (handler ${Math.round(slowest.processing)}ms)` : null,
    requests,
    repeatedRoutes,
    extra,
  }
}

/** Collapse ids so two reads of the same route count as the same route. */
export function routeKey(method: string, pathname: string): string {
  const path = pathname
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:n")
  return `${method} ${path}`
}
