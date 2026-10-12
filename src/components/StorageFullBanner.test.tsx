/**
 * AQU-1865: the one thing the user has to be told about a full disk.
 *
 * The caches bound and evict themselves and the outbox keeps taking edits, so
 * nothing breaks when storage runs out — which is exactly why this notice
 * matters: the only visible symptom is that every file open got slower, and only
 * the person at the keyboard can free the disk. It must appear when pressure is
 * real, stay out of the way otherwise, and not come back once dismissed.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { StorageFullBanner } from "./StorageFullBanner"
import {
  __resetStoragePressureForTests,
  markStorageQuotaExceeded,
} from "@/lib/storage/storage-pressure"

let session: { jwt: string; username: string; createdAt: string } | null = null
let loading = false

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({ active: session, loading }),
}))

// A dismissal is remembered per login (username + session start), in memory as
// well as in sessionStorage, so each test needs its own identity — otherwise the
// dismissal asserted below silently suppresses the banner in the next test.
let logins = 0
function signIn(username: string): { jwt: string; username: string; createdAt: string } {
  logins += 1
  return { jwt: `jwt-${logins}`, username, createdAt: `2026-10-12T00:00:0${logins}Z` }
}

beforeEach(() => {
  session = signIn("alice")
  loading = false
  // No estimate API: the banner must then depend solely on a real quota failure,
  // which is the signal this suite drives.
  Object.defineProperty(navigator, "storage", { value: {}, configurable: true, writable: true })
  window.sessionStorage.clear()
})

afterEach(() => {
  __resetStoragePressureForTests()
  vi.restoreAllMocks()
})

const message = /device is almost out of storage/i

describe("StorageFullBanner", () => {
  it("says nothing while there is room", () => {
    render(<StorageFullBanner />)
    expect(screen.queryByText(message)).toBeNull()
  })

  it("warns once a storage write has actually failed", async () => {
    render(<StorageFullBanner />)
    await act(async () => { markStorageQuotaExceeded() })
    expect(screen.getByText(message)).toBeInTheDocument()
    // The reassurance is the point: work is still being saved.
    expect(screen.getByText(/still saves and syncs/i)).toBeInTheDocument()
  })

  it("stays dismissed for the rest of the session", async () => {
    const { unmount } = render(<StorageFullBanner />)
    await act(async () => { markStorageQuotaExceeded() })
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }))
    expect(screen.queryByText(message)).toBeNull()

    // A remount — a route change, say — must not resurrect it.
    unmount()
    render(<StorageFullBanner />)
    expect(screen.queryByText(message)).toBeNull()
  })

  it("holds off until the session has resolved", async () => {
    loading = true
    const { rerender } = render(<StorageFullBanner />)
    await act(async () => { markStorageQuotaExceeded() })
    expect(screen.queryByText(message)).toBeNull()

    loading = false
    rerender(<StorageFullBanner />)
    expect(screen.getByText(message)).toBeInTheDocument()
  })

  it("re-arms for a different account in the same tab", async () => {
    const first = render(<StorageFullBanner />)
    await act(async () => { markStorageQuotaExceeded() })
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }))
    first.unmount()

    session = signIn("bob")
    render(<StorageFullBanner />)
    expect(screen.getByText(message)).toBeInTheDocument()
  })
})
