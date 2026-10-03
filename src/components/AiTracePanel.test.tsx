// AQU-1656: a prompt shown for an AI draft must say when it explains an older
// version of the cell — otherwise a translator reads it as the reason for the
// text in front of them, which someone has since changed.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { I18nProvider } from "@/lib/i18n/I18nProvider"

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt-test" } }),
}))

import { AiTracePanel } from "./AiTracePanel"

function stubTrace(status: number, body: unknown = {}) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: status < 400, status, json: () => Promise.resolve(body) })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

const show = (isCurrent: boolean) =>
  render(
    <I18nProvider>
      <AiTracePanel projectId="p1" interventionId="iv-1" isCurrent={isCurrent} />
    </I18nProvider>,
  )

describe("AiTracePanel", () => {
  beforeEach(() => vi.unstubAllGlobals())

  it("loads the prompt only when opened, and shows messages and output", async () => {
    const fetchMock = stubTrace(200, {
      messages: [{ role: "user", content: "Source: ἐργάζεσθε" }],
      output: "Do not work for the food that perishes.”",
    })
    show(true)
    expect(fetchMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Show prompt" }))
    expect(await screen.findByText("Source: ἐργάζεσθε")).toBeTruthy()
    expect(screen.getByText("Do not work for the food that perishes.”")).toBeTruthy()
    expect(screen.queryByText(/older version/)).toBeNull()
  })

  it("warns that the prompt explains an older version when the draft is no longer current", async () => {
    stubTrace(200, { messages: [], output: "old" })
    show(false)
    fireEvent.click(screen.getByRole("button", { name: "Show prompt" }))
    expect(await screen.findByText(/made on an older version/)).toBeTruthy()
  })

  it("says the prompt was not stored instead of failing", async () => {
    stubTrace(404)
    show(true)
    fireEvent.click(screen.getByRole("button", { name: "Show prompt" }))
    await waitFor(() => expect(screen.getByText("The prompt for this draft was not stored.")).toBeTruthy())
  })
})
