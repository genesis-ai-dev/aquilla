/**
 * AQU-1572: the `$exception` noise filter.
 *
 * Two things are asserted here: the predicates themselves, and that the filter
 * is actually reached through `redactCaptureEvent` — the single `before_send`
 * hook the OPS-29 drift guard pins to every `posthog.init` site. A filter that
 * is correct but unwired would leave the exception feed exactly as it was.
 */

import { describe, it, expect } from "vitest"
import {
  isLocalhostOrigin,
  isResizeObserverNoise,
  shouldDropCaptureEvent,
} from "./analytics-noise"
import { redactCaptureEvent } from "./analytics-redaction"

const RESIZE_OBSERVER_CHROME = "ResizeObserver loop completed with undelivered notifications."
const RESIZE_OBSERVER_LEGACY = "ResizeObserver loop limit exceeded"

describe("isResizeObserverNoise", () => {
  it("matches the flat $exception_message, both engine spellings", () => {
    expect(isResizeObserverNoise({ $exception_message: RESIZE_OBSERVER_CHROME })).toBe(true)
    expect(isResizeObserverNoise({ $exception_message: RESIZE_OBSERVER_LEGACY })).toBe(true)
  })

  it("matches the structured $exception_list entries", () => {
    expect(
      isResizeObserverNoise({
        $exception_list: [{ type: "Error", value: RESIZE_OBSERVER_CHROME }],
      }),
    ).toBe(true)
  })

  it("leaves a real application error alone", () => {
    expect(
      isResizeObserverNoise({
        $exception_list: [{ type: "TypeError", value: "Cannot read properties of null" }],
      }),
    ).toBe(false)
    expect(isResizeObserverNoise({})).toBe(false)
  })
})

describe("isLocalhostOrigin", () => {
  it("recognises a developer's own machine", () => {
    expect(isLocalhostOrigin({ $current_url: "http://localhost:5173/project/p1" })).toBe(true)
    expect(isLocalhostOrigin({ $current_url: "http://127.0.0.1:5173/" })).toBe(true)
  })

  it("does not fire for a deployed origin, a missing url, or an unparseable one", () => {
    expect(isLocalhostOrigin({ $current_url: "https://aquilla.app/project/p1" })).toBe(false)
    expect(isLocalhostOrigin({})).toBe(false)
    expect(isLocalhostOrigin({ $current_url: "not a url" })).toBe(false)
  })

  it("does not fire on a deployed host that merely contains 'localhost'", () => {
    expect(isLocalhostOrigin({ $current_url: "https://localhost.aquilla.app/" })).toBe(false)
  })
})

describe("shouldDropCaptureEvent", () => {
  it("drops ResizeObserver exceptions", () => {
    expect(
      shouldDropCaptureEvent({
        event: "$exception",
        properties: { $exception_message: RESIZE_OBSERVER_CHROME },
      }),
    ).toBe(true)
  })

  it("drops exceptions captured from a localhost build", () => {
    expect(
      shouldDropCaptureEvent({
        event: "$exception",
        properties: {
          $current_url: "http://localhost:5173/project/p1",
          $exception_list: [{ type: "TypeError", value: "boom" }],
        },
      }),
    ).toBe(true)
  })

  it("keeps a real exception from a deployed origin", () => {
    expect(
      shouldDropCaptureEvent({
        event: "$exception",
        properties: {
          $current_url: "https://aquilla.app/project/p1",
          $exception_list: [{ type: "TypeError", value: "boom" }],
        },
      }),
    ).toBe(false)
  })

  it("never drops an ordinary analytics event, localhost included", () => {
    // Funnel work has to be exercisable locally — only $exception is filtered.
    expect(
      shouldDropCaptureEvent({
        event: "cell validated",
        properties: { $current_url: "http://localhost:5173/project/p1" },
      }),
    ).toBe(false)
    expect(shouldDropCaptureEvent(null)).toBe(false)
  })
})

describe("redactCaptureEvent wires the filter into before_send", () => {
  it("returns null for ResizeObserver noise", () => {
    expect(
      redactCaptureEvent({
        event: "$exception",
        properties: { $exception_message: RESIZE_OBSERVER_CHROME },
      }),
    ).toBeNull()
  })

  it("returns null for a localhost exception", () => {
    expect(
      redactCaptureEvent({
        event: "$exception",
        properties: {
          $current_url: "http://127.0.0.1:5173/",
          $exception_list: [{ type: "TypeError", value: "boom" }],
        },
      }),
    ).toBeNull()
  })

  it("still redacts and forwards everything else", () => {
    const out = redactCaptureEvent({
      event: "$pageview",
      properties: { $current_url: "https://aquilla.app/join/secret-token" },
    })
    expect(out).not.toBeNull()
    expect(out?.properties?.$current_url).toBe("https://aquilla.app/join/[redacted]")
  })
})
