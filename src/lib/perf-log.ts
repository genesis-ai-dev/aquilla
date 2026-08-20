/**
 * Lightweight perf-logging helper. Off by default; enable in the browser
 * console via:
 *
 *   localStorage.PERF_LOG = "1"; location.reload()
 *
 * Or toggle without reload via the exposed global:
 *
 *   window.togglePerfLog()
 *
 * Each log is prefixed `[perf]` so you can filter the console.
 */

let enabled =
  typeof window !== "undefined" &&
  typeof window.localStorage !== "undefined" &&
  window.localStorage.getItem("PERF_LOG") === "1"

export function isPerfLogEnabled(): boolean {
  return enabled
}

export function setPerfLog(on: boolean): void {
  enabled = on
  if (typeof window !== "undefined") {
    if (on) window.localStorage.setItem("PERF_LOG", "1")
    else window.localStorage.removeItem("PERF_LOG")
  }
  // eslint-disable-next-line no-console
  console.log(`[perf] logging ${on ? "ON" : "OFF"}`)
}

/**
 * Returns a function that, when called, logs the elapsed ms since the mark
 * was created. Returns the elapsed time so callers can also chain math.
 *
 *   const end = perfMark("foo")
 *   doWork()
 *   end()  // logs "[perf] foo 12.34ms"
 */
export function perfMark(label: string): () => number {
  if (!enabled) return () => 0
  const t = performance.now()
  return () => {
    const dt = performance.now() - t
    // eslint-disable-next-line no-console
    console.log(`[perf] ${label} ${dt.toFixed(2)}ms`)
    return dt
  }
}

// ---------------------------------------------------------------------------
// Heap sampler. Diagnoses memory growth (e.g. the 3GB-on-a-small-doc report):
// correlate JS heap size with operations so we can tell churn from a true leak.
//
// Enable in the browser console:
//   window.startMemSampler()        // auto-sample every 2s + on each memMark
//   // ...reproduce the slow/heavy action (e.g. "complete all")...
//   window.memReport()              // prints a table; returns the samples
//   window.stopMemSampler()
//
// `performance.memory` is Chromium-only (Chrome / Electron). On other engines
// (Safari/WebKit, incl. the Tauri desktop webview on macOS) it's absent — the
// sampler then reports that and you should use DevTools/Web-Inspector heap
// snapshots instead. For sharper numbers in Chrome, launch with
// `--enable-precise-memory-info`.
// ---------------------------------------------------------------------------

interface MemSample {
  t: number // ms since first sample
  label: string
  usedMB: number
  deltaMB: number // change in usedMB since previous sample
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function heapUsedBytes(): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mem = (performance as any)?.memory
  return mem && typeof mem.usedJSHeapSize === "number" ? mem.usedJSHeapSize : null
}

const memSamples: MemSample[] = []
let memT0 = 0
let memTimer: ReturnType<typeof setInterval> | null = null
const MEM_SAMPLE_CAP = 2000 // ring-buffer cap so the sampler can't itself leak
const MEM_LS_KEY = "MEM_SAMPLES" // crash-survivable trail (last MEM_LS_CAP samples)
const MEM_LS_CAP = 400

// The OOM case crashes the tab before memReport() can run, taking the in-memory
// buffer with it. So each sample is ALSO (a) console.log'd immediately — turn on
// "Preserve log" in DevTools and the trail survives the crash+reload — and
// (b) persisted to localStorage so memReport() can replay it after reload.
function persistTrail(): void {
  try {
    const tail = memSamples.slice(-MEM_LS_CAP)
    window.localStorage.setItem(MEM_LS_KEY, JSON.stringify(tail))
  } catch {
    /* quota / disabled — non-fatal */
  }
}

/**
 * Record one heap sample tagged with `label`. Safe to call unconditionally —
 * no-ops when the sampler isn't running and when `performance.memory` is
 * unavailable, so instrumentation left in hot paths costs nothing in prod.
 */
export function memMark(label: string): void {
  if (memTimer === null) return // only record while actively sampling
  const used = heapUsedBytes()
  if (used === null) return
  const now = performance.now()
  if (memSamples.length === 0) memT0 = now
  const usedMB = used / 1048576
  const prev = memSamples[memSamples.length - 1]
  const sample: MemSample = {
    t: now - memT0,
    label,
    usedMB,
    deltaMB: prev ? usedMB - prev.usedMB : 0,
  }
  memSamples.push(sample)
  if (memSamples.length > MEM_SAMPLE_CAP) memSamples.shift()
  // Crash-survivable: log + persist on every sample.
  // eslint-disable-next-line no-console
  console.log(
    `[mem] ${(sample.t / 1000).toFixed(1)}s ${sample.usedMB.toFixed(0)}MB ` +
      `(Δ${sample.deltaMB >= 0 ? "+" : ""}${sample.deltaMB.toFixed(0)}) ${label}`,
  )
  persistTrail()
}

function startMemSampler(intervalMs = 250): void {
  if (heapUsedBytes() === null) {
    // eslint-disable-next-line no-console
    console.warn(
      "[mem] performance.memory unavailable on this engine (WebKit/Safari/Tauri). " +
        "Use DevTools → Memory → Heap snapshot instead, or run Chrome with --enable-precise-memory-info.",
    )
    return
  }
  if (memTimer !== null) clearInterval(memTimer)
  memSamples.length = 0
  try {
    window.localStorage.removeItem(MEM_LS_KEY)
  } catch {
    /* ignore */
  }
  memTimer = setInterval(() => memMark("·tick"), intervalMs)
  memMark("·start")
  // eslint-disable-next-line no-console
  console.log(
    `[mem] sampler started (every ${intervalMs}ms). Turn on DevTools "Preserve log" so the ` +
      `trail survives an OOM crash. After a crash, reload and run window.memReport().`,
  )
}

function stopMemSampler(): void {
  if (memTimer !== null) clearInterval(memTimer)
  memTimer = null
  memMark("·stop")
  // eslint-disable-next-line no-console
  console.log("[mem] sampler stopped")
}

function memReport(): MemSample[] {
  // After an OOM crash + reload, in-memory is empty — replay the persisted trail.
  let samples = memSamples
  if (samples.length === 0) {
    try {
      const raw = window.localStorage.getItem(MEM_LS_KEY)
      if (raw) {
        samples = JSON.parse(raw) as MemSample[]
        // eslint-disable-next-line no-console
        console.log(`[mem] replaying ${samples.length} persisted samples from last run (pre-crash trail)`)
      }
    } catch {
      /* ignore */
    }
  }
  if (samples.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[mem] no samples. Run window.startMemSampler() first.")
    return []
  }
  const peak = Math.max(...samples.map((s) => s.usedMB))
  const first = samples[0].usedMB
  const last = samples[samples.length - 1].usedMB
  // eslint-disable-next-line no-console
  console.table(
    samples.map((s) => ({
      "t(s)": (s.t / 1000).toFixed(1),
      label: s.label,
      "used(MB)": s.usedMB.toFixed(1),
      "Δ(MB)": s.deltaMB.toFixed(1),
    })),
  )
  // eslint-disable-next-line no-console
  console.log(
    `[mem] first=${first.toFixed(0)}MB last=${last.toFixed(0)}MB peak=${peak.toFixed(0)}MB ` +
      `net=${(last - first).toFixed(0)}MB over ${(samples[samples.length - 1].t / 1000).toFixed(0)}s`,
  )
  return samples
}

// Expose a console-friendly toggle so you don't have to reach for localStorage.
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).togglePerfLog = () => setPerfLog(!enabled)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).setPerfLog = setPerfLog
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).startMemSampler = startMemSampler
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).stopMemSampler = stopMemSampler
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).memReport = memReport
}
