import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { CheckingPage } from "./CheckingPage"
const request = vi.hoisted(() => vi.fn())
vi.mock("@/lib/checking/api", () => ({ checkingRequest: request }))
vi.mock("@/lib/checking/feedback", () => ({ flushCheckingFeedback: vi.fn().mockResolvedValue(0), queueCheckingFeedback: vi.fn() }))
beforeEach(() => {
  localStorage.clear()
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {})
  request.mockReset()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function mount(role: string, audio: Array<{ cellId: string; audioId: string }> = []) {
  localStorage.setItem("aquilla:checking:link", JSON.stringify({ session: "s", guestId: "g", name: "Kathryn", title: "Listen", role, projectId: "p" }))
  request.mockResolvedValue({ rows: [
    { fileId: "f", cellId: "1", fileName: "Mark", label: "MRK 1:1", text: "First passage", side: "source", paragraphStart: true },
    { fileId: "f", cellId: "2", fileName: "Mark", label: "MRK 1:2", text: "Second passage", side: "source" },
    { fileId: "f", cellId: "3", fileName: "Mark", label: "MRK 1:3", text: "Third passage", side: "source", paragraphStart: true },
  ], audio: audio.map(clip => ({ fileId: "f", url: "frontier-audio://x", trimStartMs: null, trimEndMs: null, ...clip })) })
  render(<MemoryRouter initialEntries={["/check/link"]}><Routes><Route path="/check/:token" element={<CheckingPage />} /></Routes></MemoryRouter>)
}
describe("checking guest page", () => {
  it("keeps feedback drafts attached to their passage when navigating", async () => {
    mount("commenter")
    const draft = await screen.findByRole("textbox", { name: "Feedback on MRK 1:1" })
    fireEvent.change(draft, { target: { value: "First passage feedback" } })
    fireEvent.click(screen.getByRole("button", { name: /Second passage/ }))
    expect(screen.getByRole("textbox", { name: "Feedback on MRK 1:2" })).toHaveValue("")
    fireEvent.click(screen.getByRole("button", { name: /First passage/ }))
    expect(screen.getByRole("textbox", { name: "Feedback on MRK 1:1" })).toHaveValue("First passage feedback")
  })
  it("shows the passages as running text, breaking paragraphs only where the file does", async () => {
    // Listeners read along as with a document; one card per verse loses the flow.
    mount("viewer")
    const document = await screen.findByRole("article", { name: "Shared passages" })
    const paragraphs = [...document.querySelectorAll("p")].map(p => p.textContent?.replace(/\s+/g, " ").trim())
    expect(paragraphs).toEqual(["1:1First passage 1:2Second passage", "1:3Third passage"])
  })
  it("attaches feedback to the passage being heard, and shows it under that passage once sent", async () => {
    const { queueCheckingFeedback } = await import("@/lib/checking/feedback")
    mount("commenter")
    fireEvent.click(await screen.findByRole("button", { name: /Third passage/ }))
    fireEvent.change(screen.getByRole("textbox", { name: "Feedback on MRK 1:3" }), { target: { value: "Clear and natural" } })
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }))
    await waitFor(() => expect(queueCheckingFeedback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ cellId: "3" }), "Clear and natural"))
    expect(await screen.findByRole("list", { name: "Your feedback on this passage" })).toHaveTextContent("Clear and natural")
    fireEvent.click(screen.getByRole("button", { name: /First passage/ }))
    expect(screen.queryByRole("list", { name: "Your feedback on this passage" })).not.toBeInTheDocument()
  })
  it("does not offer feedback controls on viewer links", async () => {
    mount("viewer")
    await waitFor(() => expect(screen.getByText("First passage")).toBeVisible())
    expect(screen.queryByRole("button", { name: "Send feedback" })).not.toBeInTheDocument()
  })
  it("downloads the next passage's recording while the current one plays, so listening does not stall between verses", async () => {
    // Kathryn's teams listen straight through. Fetching each clip only after
    // the previous one ends leaves a network-length silence at every verse.
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:clip", revokeObjectURL: () => {} }))
    const fetched: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      fetched.push(new URL(url).searchParams.get("audioId") ?? "")
      return new Response(new Blob(["clip"]))
    }))
    mount("viewer", [{ cellId: "1", audioId: "a1" }, { cellId: "2", audioId: "a2" }])
    await waitFor(() => expect(fetched).toEqual(["a1", "a2"]))
    fireEvent.ended(screen.getByLabelText("Passage recording"))
    expect(await screen.findByRole("heading", { name: "MRK 1:2" })).toBeVisible()
    expect(screen.getByRole("button", { name: /Second passage/ })).toHaveAttribute("aria-current", "true")
    // The second clip is served from the prefetch, not downloaded again.
    await waitFor(() => expect(screen.getByLabelText("Passage recording")).toHaveAttribute("src", "blob:clip"))
    expect(fetched).toEqual(["a1", "a2"])
    vi.unstubAllGlobals()
  })
})
