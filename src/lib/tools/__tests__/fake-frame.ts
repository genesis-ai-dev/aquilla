/**
 * In-process stand-in for a sandboxed tool iframe, for unit tests.
 *
 * happy-dom does not execute scripts inside srcdoc frames, so this fake pairs
 * two EventTarget "windows" with a postMessage that delivers asynchronously
 * with the right `source` and an opaque `origin` ("null"), and runs the
 * srcdoc's inline scripts in order against a detached document — exactly the
 * runtime source and tool source that ship.
 *
 * Every delivery is a 0 ms timer. One that outlives its test fires after
 * vitest has torn the happy-dom environment down, where the global `Event` is
 * Node's again and happy-dom's EventTarget refuses it — an unhandled error
 * charged to whichever file the scheduler reached next, failing a run with
 * zero failing tests (AQU-2072). So each window tracks what it has in flight,
 * a closed window drops it, and the after-each hook below cancels the rest.
 */

import { afterEach } from "vitest"
import type { SmokeFrame } from "../smoke"

type Listener = (e: Event) => void
type Timer = ReturnType<typeof setTimeout>

/** Every window this module instance has made, for the after-each hook. */
const windows = new Set<FakeWindow>()

export class FakeWindow extends EventTarget {
  peer: FakeWindow | null = null
  parent: FakeWindow
  [key: string]: unknown
  /** Set by `close()`: like a removed iframe, a closed window delivers nothing more. */
  closed = false
  /** Deliveries scheduled but not yet dispatched. */
  readonly pending = new Set<Timer>()

  constructor() {
    super()
    this.parent = this
    windows.add(this)
  }

  /** Run `fn` on a 0 ms timer that `cancelPending()` can still stop. */
  later(fn: () => void): void {
    if (this.closed) return
    const timer = setTimeout(() => {
      this.pending.delete(timer)
      if (!this.closed) fn()
    }, 0)
    this.pending.add(timer)
  }

  /** Called ON the target window by its peer. */
  postMessage(data: unknown): void {
    const sender = this.peer
    const cloned: unknown = JSON.parse(JSON.stringify(data ?? null))
    this.later(() => {
      const ev = new Event("message")
      Object.defineProperties(ev, {
        data: { value: cloned },
        origin: { value: "null" },
        source: { value: sender },
      })
      this.dispatchEvent(ev)
    })
  }

  /** Deliver a message that claims to come from `source` (spoof tests). */
  deliverFrom(source: unknown, data: unknown, origin = "null"): void {
    const ev = new Event("message")
    Object.defineProperties(ev, { data: { value: data }, origin: { value: origin }, source: { value: source } })
    this.dispatchEvent(ev)
  }

  /** Drop every delivery still in flight. The window stays usable. */
  cancelPending(): void {
    for (const timer of this.pending) clearTimeout(timer)
    this.pending.clear()
  }

  /** Drop what is in flight and ignore anything scheduled from now on. */
  close(): void {
    this.closed = true
    this.cancelPending()
    windows.delete(this)
  }

  override addEventListener(type: string, cb: Listener | EventListenerObject | null): void {
    super.addEventListener(type, cb)
  }
}

/** Cancel every delivery still in flight on every window this module has made. */
export function cancelPendingFakeFrameDeliveries(): void {
  for (const w of windows) w.cancelPending()
}

// Registered on the importing test file's root suite, so nothing a test
// scheduled can fire once that test is over, whether or not the test disposed
// its pair. Relies on vitest evaluating this module once per test file, which
// its per-file isolation does.
afterEach(cancelPendingFakeFrameDeliveries)

export interface FakeFramePair {
  host: FakeWindow
  frame: FakeWindow
  doc: Document
  /** Run every inline <script> of `srcdoc` in the frame, then fire load. */
  run: (srcdoc: string) => void
  /** Close both windows: what is in flight is dropped and nothing more is scheduled. */
  dispose: () => void
}

const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi

export function createFakeFramePair(): FakeFramePair {
  const host = new FakeWindow()
  const frame = new FakeWindow()
  host.peer = frame
  frame.peer = host
  frame.parent = host
  const doc = document.implementation.createHTMLDocument("tool")

  const run = (srcdoc: string) => {
    const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(srcdoc)
    doc.body.innerHTML = (bodyMatch ? bodyMatch[1] : "").replace(SCRIPT_RE, "")
    const scripts = [...srcdoc.matchAll(SCRIPT_RE)].map((m) => m[1])
    for (const code of scripts) {
      try {
        const { aquilla, aq } = frame
        // eslint-disable-next-line @typescript-eslint/no-implied-eval -- test harness: runs the shipped runtime/tool source in a fake frame
        new Function("window", "document", "aquilla", "aq", code)(frame, doc, aquilla, aq)
      } catch (error) {
        const ev = new Event("error")
        // As a browser reports an error thrown by the srcdoc's own inline script.
        Object.defineProperties(ev, { error: { value: error }, message: { value: String(error) }, filename: { value: "about:srcdoc" } })
        frame.dispatchEvent(ev)
      }
    }
    frame.later(() => frame.dispatchEvent(new Event("load")))
  }
  const dispose = () => {
    host.close()
    frame.close()
  }
  return { host, frame, doc, run, dispose }
}

/** A SmokeFrame backed by the fake pair. */
export function fakeSmokeFrame(): SmokeFrame {
  const pair = createFakeFramePair()
  return {
    toolWindow: pair.frame as unknown as Window,
    hostWindow: pair.host as unknown as Window,
    start: (srcdoc) => pair.run(srcdoc),
    dispose: () => pair.dispose(),
  }
}
