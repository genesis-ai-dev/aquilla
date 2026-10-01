// Dev-only diagnostics for the LiveStore leader worker. WKWebView only shows a
// worker's console in Safari Web Inspector, so a leader that dies after boot is
// otherwise invisible. The worker side forwards console output and uncaught
// errors over a BroadcastChannel; the page side keeps a ring buffer on
// `window.__leaderLogs` that the Tauri MCP bridge can read.
const CHANNEL = "aquilla-livestore-leader-log"
const MAX_ENTRIES = 500

export type LeaderLogEntry = { ts: string; source: string; level: string; text: string }

const stringify = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

// Drops `%c` style arguments so Effect's pretty logger stays readable.
const formatArgs = (args: unknown[]): string => {
  const [first, ...rest] = args
  if (typeof first !== "string" || !first.includes("%c")) return args.map(stringify).join(" ")
  const styleCount = first.split("%c").length - 1
  return [first.replaceAll("%c", ""), ...rest.slice(styleCount)].map(stringify).join(" ")
}

/** Worker side: call once at the top of the leader worker entry. */
export function installLeaderLogForwarder(): void {
  const channel = new BroadcastChannel(CHANNEL)
  const source = typeof self !== "undefined" && "name" in self ? String(self.name) : "leader"
  const post = (level: string, text: string) => {
    try {
      channel.postMessage({ ts: new Date().toISOString(), source, level, text } satisfies LeaderLogEntry)
    } catch {
      // Diagnostics must never break the leader.
    }
  }
  for (const level of ["log", "info", "warn", "error", "debug", "group", "groupCollapsed"] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      post(level, formatArgs(args))
      original(...args)
    }
  }
  self.addEventListener("error", (e) => post("uncaught", `${e.message} @ ${e.filename}:${e.lineno}\n${stringify(e.error)}`))
  self.addEventListener("unhandledrejection", (e) => post("unhandledrejection", stringify(e.reason)))
  post("info", "leader log forwarder installed")
}

type LeaderLogWindow = Window & { __leaderLogs?: LeaderLogEntry[]; __leaderWorker?: Worker }

const record = (entry: LeaderLogEntry) => {
  const w = window as LeaderLogWindow
  const logs = (w.__leaderLogs ??= [])
  logs.push(entry)
  if (logs.length > MAX_ENTRIES) logs.splice(0, logs.length - MAX_ENTRIES)
}

let listening = false

/** Page side: collect forwarded leader logs into `window.__leaderLogs`. */
export function installLeaderLogCollector(): void {
  if (listening) return
  listening = true
  new BroadcastChannel(CHANNEL).addEventListener("message", (e: MessageEvent<LeaderLogEntry>) => record(e.data))
}

/**
 * Page side: record lifecycle errors raised on the leader `Worker` object
 * itself, and expose it as `window.__leaderWorker` so a dead leader can be
 * simulated with `__leaderWorker.terminate()`.
 */
export function watchLeaderWorker(worker: Worker, name: string): void {
  ;(window as LeaderLogWindow).__leaderWorker = worker
  const now = () => new Date().toISOString()
  record({ ts: now(), source: name, level: "lifecycle", text: "worker constructed" })
  worker.addEventListener("error", (e) =>
    record({ ts: now(), source: name, level: "worker-error", text: `${e.message} @ ${e.filename}:${e.lineno}` }),
  )
  worker.addEventListener("messageerror", () =>
    record({ ts: now(), source: name, level: "worker-messageerror", text: "message could not be deserialized" }),
  )
}
