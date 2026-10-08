/**
 * In-process stand-in for a sandboxed tool iframe, for unit tests.
 *
 * happy-dom does not execute scripts inside srcdoc frames, so this fake pairs
 * two EventTarget "windows" with a postMessage that delivers asynchronously
 * with the right `source` and an opaque `origin` ("null"), and runs the
 * srcdoc's inline scripts in order against a detached document — exactly the
 * runtime source and tool source that ship.
 */

import type { SmokeFrame } from "../smoke"

type Listener = (e: Event) => void

export class FakeWindow extends EventTarget {
  peer: FakeWindow | null = null
  parent: FakeWindow
  [key: string]: unknown

  constructor() {
    super()
    this.parent = this
  }

  /** Called ON the target window by its peer. */
  postMessage(data: unknown): void {
    const sender = this.peer
    const cloned: unknown = JSON.parse(JSON.stringify(data ?? null))
    setTimeout(() => {
      const ev = new Event("message")
      Object.defineProperties(ev, {
        data: { value: cloned },
        origin: { value: "null" },
        source: { value: sender },
      })
      this.dispatchEvent(ev)
    }, 0)
  }

  /** Deliver a message that claims to come from `source` (spoof tests). */
  deliverFrom(source: unknown, data: unknown, origin = "null"): void {
    const ev = new Event("message")
    Object.defineProperties(ev, { data: { value: data }, origin: { value: origin }, source: { value: source } })
    this.dispatchEvent(ev)
  }

  override addEventListener(type: string, cb: Listener | EventListenerObject | null): void {
    super.addEventListener(type, cb)
  }
}

export interface FakeFramePair {
  host: FakeWindow
  frame: FakeWindow
  doc: Document
  /** Run every inline <script> of `srcdoc` in the frame, then fire load. */
  run: (srcdoc: string) => void
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
        const aquilla = frame.aquilla
        // eslint-disable-next-line @typescript-eslint/no-implied-eval -- test harness: runs the shipped runtime/tool source in a fake frame
        new Function("window", "document", "aquilla", code)(frame, doc, aquilla)
      } catch (error) {
        const ev = new Event("error")
        Object.defineProperties(ev, { error: { value: error }, message: { value: String(error) } })
        frame.dispatchEvent(ev)
      }
    }
    setTimeout(() => frame.dispatchEvent(new Event("load")), 0)
  }
  return { host, frame, doc, run }
}

/** A SmokeFrame backed by the fake pair. */
export function fakeSmokeFrame(): SmokeFrame {
  const pair = createFakeFramePair()
  return {
    toolWindow: pair.frame as unknown as Window,
    hostWindow: pair.host as unknown as Window,
    start: (srcdoc) => pair.run(srcdoc),
    dispose: () => {},
  }
}
