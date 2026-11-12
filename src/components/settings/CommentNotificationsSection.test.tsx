// Tests for CommentNotificationsSection: the comment-email preference control.
//
// WHY these tests matter: this is the only surface where a user can turn off or
// widen comment email (AQU-1193). The intent they encode is (a) the control
// shows what the SERVER currently holds rather than an optimistic default,
// (b) choosing an option actually persists it, (c) a failed save does not leave
// a value on screen that the server never accepted, and (d) signed-out visitors
// see no card at all.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommentNotificationsSection } from "./CommentNotificationsSection"

vi.mock("@/lib/notifications/comment-email-pref", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notifications/comment-email-pref")>()
  return {
    ...actual,
    fetchCommentEmailPreference: vi.fn(),
    saveCommentEmailPreference: vi.fn(),
  }
})
vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: vi.fn(() => ({ session: { jwt: "test-jwt" }, loading: false })),
}))

import {
  fetchCommentEmailPreference,
  saveCommentEmailPreference,
} from "@/lib/notifications/comment-email-pref"
import { useFrontierSession } from "@/hooks/useFrontierSession"

const mockFetch = vi.mocked(fetchCommentEmailPreference)
const mockSave = vi.mocked(saveCommentEmailPreference)
const mockSession = vi.mocked(useFrontierSession)

function signedIn() {
  mockSession.mockReturnValue({
    session: { jwt: "test-jwt" } as ReturnType<typeof useFrontierSession>["session"],
    loading: false,
    sessionLoadError: null,
    retrySessionLoad: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  signedIn()
})
afterEach(() => vi.restoreAllMocks())

describe("CommentNotificationsSection", () => {
  it("shows the setting the server holds, not the local default", async () => {
    // WHY: rendering "Only when someone @-mentions me" for a user who is on
    // `all` would tell them they are getting less email than they are.
    mockFetch.mockResolvedValue("all")
    render(<CommentNotificationsSection />)

    await waitFor(() =>
      expect(screen.getByText("Every mention and reply")).toBeInTheDocument(),
    )
    expect(mockFetch).toHaveBeenCalledWith("test-jwt")
  })

  it("persists the chosen option", async () => {
    // WHY: the control is worthless if the choice never reaches the server that
    // decides whether to send the mail.
    mockFetch.mockResolvedValue("mentions")
    mockSave.mockResolvedValue("off")
    render(<CommentNotificationsSection />)
    await waitFor(() =>
      expect(screen.getByText("Only when someone @-mentions me")).toBeInTheDocument(),
    )

    await userEvent.click(screen.getByLabelText("Email me about comments"))
    await userEvent.click(await screen.findByRole("option", { name: "Never" }))

    await waitFor(() => expect(mockSave).toHaveBeenCalledWith("test-jwt", "off"))
    // Assert on the trigger, not the document: the open popup also lists every
    // option, so a bare getByText would match the menu item too.
    await waitFor(() =>
      expect(screen.getByLabelText("Email me about comments")).toHaveTextContent("Never"),
    )
  })

  it("reverts and explains when the save fails", async () => {
    // WHY: leaving "Never" on screen after a failed write would have someone
    // believe they had silenced email that is still being sent.
    mockFetch.mockResolvedValue("mentions")
    mockSave.mockRejectedValue(new Error("HTTP 500"))
    render(<CommentNotificationsSection />)
    await waitFor(() =>
      expect(screen.getByText("Only when someone @-mentions me")).toBeInTheDocument(),
    )

    await userEvent.click(screen.getByLabelText("Email me about comments"))
    await userEvent.click(await screen.findByRole("option", { name: "Never" }))

    await waitFor(() =>
      expect(screen.getByText("Could not save that setting")).toBeInTheDocument(),
    )
    expect(screen.getByLabelText("Email me about comments")).toHaveTextContent(
      "Only when someone @-mentions me",
    )
  })

  it("surfaces a load failure instead of a plausible-looking default", async () => {
    // WHY: same reason as above — a default shown after a failed read is a
    // claim about the account that was never verified.
    mockFetch.mockRejectedValue(new Error("HTTP 401"))
    render(<CommentNotificationsSection />)

    await waitFor(() =>
      expect(
        screen.getByText("Could not load your notification setting"),
      ).toBeInTheDocument(),
    )
  })

  it("renders nothing when the user is signed out", () => {
    mockSession.mockReturnValue({
      session: null,
      loading: false,
      sessionLoadError: null,
      retrySessionLoad: vi.fn(),
      login: vi.fn(),
      register: vi.fn(),
      logout: vi.fn(),
    })
    const { container } = render(<CommentNotificationsSection />)
    expect(container).toBeEmptyDOMElement()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
