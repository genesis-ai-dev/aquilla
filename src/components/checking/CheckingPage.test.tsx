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
function mount(role: string) {
  localStorage.setItem("aquilla:checking:link", JSON.stringify({ session: "s", guestId: "g", name: "Kathryn", title: "Listen", role, projectId: "p" }))
  request.mockResolvedValue({ rows: [
    { fileId: "f", cellId: "1", fileName: "Mark", label: "MRK 1:1", text: "First passage", side: "source" },
    { fileId: "f", cellId: "2", fileName: "Mark", label: "MRK 1:2", text: "Second passage", side: "source" },
  ], audio: [] })
  render(<MemoryRouter initialEntries={["/check/link"]}><Routes><Route path="/check/:token" element={<CheckingPage />} /></Routes></MemoryRouter>)
}
describe("checking guest page", () => {
  it("keeps feedback drafts attached to their passage when navigating", async () => {
    mount("commenter")
    const draft = await screen.findByRole("textbox", { name: "Feedback on MRK 1:1" })
    fireEvent.change(draft, { target: { value: "First passage feedback" } })
    fireEvent.click(screen.getByRole("button", { name: "Mark · MRK 1:2" }))
    expect(screen.getByRole("textbox", { name: "Feedback on MRK 1:2" })).toHaveValue("")
    fireEvent.click(screen.getByRole("button", { name: "Mark · MRK 1:1" }))
    expect(screen.getByRole("textbox", { name: "Feedback on MRK 1:1" })).toHaveValue("First passage feedback")
  })
  it("does not offer feedback controls on viewer links", async () => {
    mount("viewer")
    await waitFor(() => expect(screen.getByText("First passage")).toBeVisible())
    expect(screen.queryByRole("button", { name: "Send feedback" })).not.toBeInTheDocument()
  })
})
