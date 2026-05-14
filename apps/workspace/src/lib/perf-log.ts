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

export function perfLog(label: string, ...args: unknown[]): void {
  if (!enabled) return
  // eslint-disable-next-line no-console
  console.log(`[perf] ${label}`, ...args)
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

// Expose a console-friendly toggle so you don't have to reach for localStorage.
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).togglePerfLog = () => setPerfLog(!enabled)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).setPerfLog = setPerfLog
}
