import { describe, expect, it, vi } from "vitest"
import {
  dropNoisyExceptions,
  installResizeObserverNoiseGuard,
  isResizeObserverLoopMessage,
  type FilterableCaptureEvent,
} from "./analytics-exception-filter"
import { REDACTED, redactCaptureEvent } from "./analytics-redaction"

const PROD_URL = "https://aquilla.app/project/abc/editor"

/**
 * An `$exception` shaped the way posthog-js builds one: `$exception_list` with
 * the raised exception first, `{ type, value, mechanism, stacktrace }` each.
 */
function exception(value: string, currentUrl = PROD_URL, type = "Error"): FilterableCaptureEvent {
  return {
    event: "$exception",
    properties: {
      $exception_list: [
        { type, value, mechanism: { type: "generic", handled: false, synthetic: true } },
      ],
      $exception_level: "error",
      $current_url: currentUrl,
    },
  }
}

/** posthog-js's own semantics for a `before_send` array: in order, stop at the first null. */
function runBeforeSend(
  fns: ((e: FilterableCaptureEvent | null) => FilterableCaptureEvent | null)[],
  event: FilterableCaptureEvent,
): FilterableCaptureEvent | null {
  let result: FilterableCaptureEvent | null = event
  for (const fn of fns) {
    result = fn(result)
    if (!result) return null
  }
  return result
}

describe("isResizeObserverLoopMessage (AQU-1572)", () => {
  it("matches both browser wordings", () => {
    expect(isResizeObserverLoopMessage("ResizeObserver loop completed with undelivered notifications.")).toBe(true)
    expect(isResizeObserverLoopMessage("ResizeObserver loop limit exceeded")).toBe(true)
  })

  it("matches with an 'Uncaught' prefix and regardless of case", () => {
    expect(isResizeObserverLoopMessage("Uncaught ResizeObserver loop limit exceeded")).toBe(true)
    expect(isResizeObserverLoopMessage("resizeobserver loop completed with undelivered notifications")).toBe(true)
  })

  it("does not match real errors that merely mention ResizeObserver", () => {
    expect(isResizeObserverLoopMessage("ResizeObserver is not defined")).toBe(false)
    expect(isResizeObserverLoopMessage("Cannot read properties of undefined (reading 'observe')")).toBe(false)
    expect(isResizeObserverLoopMessage(undefined)).toBe(false)
    expect(isResizeObserverLoopMessage(42)).toBe(false)
  })
})

describe("dropNoisyExceptions (AQU-1572)", () => {
  it("drops the ResizeObserver loop warning in either wording", () => {
    expect(dropNoisyExceptions(exception("ResizeObserver loop completed with undelivered notifications."))).toBeNull()
    expect(dropNoisyExceptions(exception("ResizeObserver loop limit exceeded"))).toBeNull()
  })

  it("drops the legacy flat $exception_message form too", () => {
    const legacy = {
      event: "$exception",
      properties: {
        $exception_message: "ResizeObserver loop limit exceeded",
        $exception_type: "Error",
        $current_url: PROD_URL,
      },
    }
    expect(dropNoisyExceptions(legacy)).toBeNull()
  })

  it("keeps a real exception from production", () => {
    const real = exception("Cannot read properties of undefined (reading 'cells')", PROD_URL, "TypeError")
    expect(dropNoisyExceptions(real)).toBe(real)
  })

  it("keeps a real exception whose cause chain mentions ResizeObserver", () => {
    // Only the raised exception (index 0) decides; a cause is context.
    const event = exception("Pane layout failed")
    ;(event.properties!.$exception_list as unknown[]).push({
      type: "Error",
      value: "ResizeObserver loop limit exceeded",
    })
    expect(dropNoisyExceptions(event)).toBe(event)
  })

  it("drops any exception captured on a localhost build", () => {
    for (const url of [
      "http://localhost:5173/app",
      "http://127.0.0.1:5173/app",
      "http://[::1]:5173/app",
      "http://0.0.0.0:5173/app",
      "http://aquilla.localhost:5173/app",
    ]) {
      expect(dropNoisyExceptions(exception("boom", url)), url).toBeNull()
    }
  })

  it("keeps exceptions from the Tauri desktop shell, which also looks like localhost", () => {
    const mac = exception("boom", "tauri://localhost/app")
    const windows = exception("boom", "http://tauri.localhost/app")
    expect(dropNoisyExceptions(mac)).toBe(mac)
    expect(dropNoisyExceptions(windows)).toBe(windows)
  })

  it("keeps exceptions from dev and preview deployments", () => {
    for (const url of [
      "https://dev.aquilla.app/app",
      "https://pr-274-aquilla-web-preview.blue-darkness-7674.workers.dev/app",
    ]) {
      const event = exception("boom", url)
      expect(dropNoisyExceptions(event), url).toBe(event)
    }
  })

  it("keeps an exception whose page URL is missing or unparseable (fails open)", () => {
    const noUrl = { event: "$exception", properties: { $exception_list: [{ type: "Error", value: "boom" }] } }
    const badUrl = exception("boom", "not a url")
    expect(dropNoisyExceptions(noUrl)).toBe(noUrl)
    expect(dropNoisyExceptions(badUrl)).toBe(badUrl)
  })

  it("leaves non-exception events alone, even from localhost", () => {
    const pageview = { event: "$pageview", properties: { $current_url: "http://localhost:5173/app" } }
    const custom = {
      event: "cell validated",
      properties: { note: "ResizeObserver loop limit exceeded", $current_url: PROD_URL },
    }
    expect(dropNoisyExceptions(pageview)).toBe(pageview)
    expect(dropNoisyExceptions(custom)).toBe(custom)
  })

  it("passes null through and copes with an event that has no properties", () => {
    expect(dropNoisyExceptions(null)).toBeNull()
    const bare = { event: "$exception" }
    expect(dropNoisyExceptions(bare)).toBe(bare)
  })
})

// The chain posthog.ts installs: `before_send: [dropNoisyExceptions, redactCaptureEvent]`.
describe("the before_send chain (AQU-1572 + OPS-29)", () => {
  const chain = [dropNoisyExceptions, redactCaptureEvent]

  it("drops noise before redaction ever sees it", () => {
    expect(runBeforeSend(chain, exception("ResizeObserver loop limit exceeded"))).toBeNull()
    expect(runBeforeSend(chain, exception("boom", "http://localhost:5173/join/tok"))).toBeNull()
  })

  it("still redacts a surviving exception's page URL", () => {
    const out = runBeforeSend(chain, exception("boom", "https://aquilla.app/join/invite-token"))
    expect(out?.properties?.$current_url).toBe(`https://aquilla.app/join/${REDACTED}`)
    expect(out?.properties?.$exception_list).toEqual([
      expect.objectContaining({ type: "Error", value: "boom" }),
    ])
  })
})

describe("installResizeObserverNoiseGuard", () => {
  it("keeps the ResizeObserver warning from later error handlers, and nothing else", () => {
    const target = new EventTarget() as unknown as Window
    installResizeObserverNoiseGuard(target)
    // Stands in for posthog-js's onerror wrapper, registered after the guard.
    const later = vi.fn()
    target.addEventListener("error", later)

    target.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }))
    target.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop limit exceeded" }))
    expect(later).not.toHaveBeenCalled()

    target.dispatchEvent(new ErrorEvent("error", { message: "TypeError: x is undefined" }))
    expect(later).toHaveBeenCalledTimes(1)
  })
})
