// Tests for the shared theme primitive. These cover the cross-app contract:
// localStorage round-trip, html.dark class application, and storage-event
// sync (the mechanism that keeps two open tabs / apps in sync without a
// refresh).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, act, fireEvent } from "@testing-library/react"
import {
  ThemeProvider,
  ThemeToggle,
  useTheme,
  applyStoredTheme,
  THEME_STORAGE_KEY,
} from "./theme-mode"

function CurrentMode() {
  const { mode, resolved } = useTheme()
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="resolved">{resolved}</span>
    </div>
  )
}

describe("ThemeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.classList.remove("dark")
    // Default matchMedia → light. Each test overrides as needed.
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.classList.remove("dark")
  })

  it("defaults to system mode and resolves against prefers-color-scheme", () => {
    render(
      <ThemeProvider>
        <CurrentMode />
      </ThemeProvider>,
    )
    expect(screen.getByTestId("mode")).toHaveTextContent("system")
    expect(screen.getByTestId("resolved")).toHaveTextContent("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("toggles light → dark → system on click", () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
        <CurrentMode />
      </ThemeProvider>,
    )
    const toggle = screen.getByTestId("theme-toggle")
    // system → light
    act(() => fireEvent.click(toggle))
    expect(screen.getByTestId("mode")).toHaveTextContent("light")
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    // light → dark
    act(() => fireEvent.click(toggle))
    expect(screen.getByTestId("mode")).toHaveTextContent("dark")
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
    // dark → system
    act(() => fireEvent.click(toggle))
    expect(screen.getByTestId("mode")).toHaveTextContent("system")
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system")
  })

  it("picks up cross-tab storage events", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light")
    render(
      <ThemeProvider>
        <CurrentMode />
      </ThemeProvider>,
    )
    expect(screen.getByTestId("mode")).toHaveTextContent("light")

    // Simulate the sibling app writing "dark" to localStorage. The
    // browser fires a `storage` event on OTHER tabs — our listener
    // re-reads the key.
    act(() => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "dark")
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: THEME_STORAGE_KEY,
          newValue: "dark",
        }),
      )
    })
    expect(screen.getByTestId("mode")).toHaveTextContent("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })
})

describe("applyStoredTheme", () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.classList.remove("dark")
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.documentElement.classList.remove("dark")
  })

  it("returns 'light' and removes dark class when nothing stored + system is light", () => {
    expect(applyStoredTheme()).toBe("light")
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("returns 'dark' and adds dark class when explicit dark is stored", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark")
    expect(applyStoredTheme()).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })
})
