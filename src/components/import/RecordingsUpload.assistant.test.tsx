// AQU-2302: the assistant works out a folder's naming only when the person
// asks, once, with one retry at most; the rule it gives is applied and checked
// here, and a team's saved rule is used with no call at all.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TargetFile, TargetLine } from "@/lib/audio/bulk-upload/match"

const MAT = [25, 23, 17, 25, 48, 34, 29, 34, 38, 42, 30, 50, 58, 36, 39, 28, 27, 35, 30, 34, 46, 46, 39, 51, 46, 75, 66, 20]

function matthew(): TargetFile {
  const lines: TargetLine[] = []
  MAT.forEach((count, ci) => {
    for (let v = 1; v <= count; v++) lines.push({ cellId: `mat:${ci + 1}:${v}`, ref: `MAT ${ci + 1}:${v}`, text: `Matthew ${ci + 1}:${v}`, structural: false, hasRecording: false })
  })
  return { fileId: "mat", name: "Matthew", bookCode: "MAT", lines }
}

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt-lee", username: "lee" } }),
}))
vi.mock("@/lib/audio/bulk-upload/load-targets", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/audio/bulk-upload/load-targets")>()),
  learnHeaderNames: vi.fn(async () => {}),
  loadTargetFile: vi.fn(async () => matthew()),
}))
const started = vi.fn(async () => {})
vi.mock("@/lib/audio/bulk-upload/engine", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/audio/bulk-upload/engine")>()),
  startBulkUpload: (...args: unknown[]) => started(...(args as [])),
  isBulkUploadRunning: () => false,
}))

import { RecordingsReview } from "./RecordingsUpload"

const RULE = {
  templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }],
  books: { Mt: "MAT" },
  explanation: "Mt is Matthew; then the chapter and the verse.",
}

const NAMES = ["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg", "Mt-ch22_v32.ogg"]

function chosen(names: readonly string[]) {
  return names.map((name) => ({ file: new File([new Uint8Array(16)], name, { type: "audio/ogg" }), path: `Files/${name}` }))
}

type Route = { method: string; url: string; body: Record<string, unknown> | null; signal: AbortSignal | null }
/** An answer that fails, and one that never comes until the request is aborted. */
const FAIL = Symbol("fail")
const HANG = Symbol("hang")
let calls: Route[] = []
let answers: unknown[] = []
let saved: Record<string, unknown> = {}
let lookupDelay = 30

beforeEach(() => {
  calls = []
  answers = [RULE]
  saved = {}
  lookupDelay = 30
  started.mockClear()
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null, signal: init?.signal ?? null })
    // Answered a little later, as a real server would: the preview re-renders
    // meanwhile, which once cancelled the saved-rule lookup (Chromium, Oct 30).
    if (url.includes("/recording-names/saved") && method === "GET") {
      await new Promise((r) => setTimeout(r, lookupDelay))
      return new Response(JSON.stringify({ rules: saved }), { status: 200 })
    }
    if (url.includes("/recording-names/saved") && method === "DELETE") return new Response(JSON.stringify({ forgotten: true }), { status: 200 })
    if (url.includes("/recording-names/saved")) return new Response(JSON.stringify({ saved: true }), { status: 200 })
    if (url.includes("/recording-names")) {
      // Out of answers means the model failed: never a good rule by default.
      const answer = answers.length > 0 ? answers.shift() : FAIL
      if (answer === HANG) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        })
      }
      if (answer === FAIL) {
        await new Promise((r) => setTimeout(r, 20))
        return new Response(JSON.stringify({ error: "invalid_naming_rule" }), { status: 502 })
      }
      return new Response(JSON.stringify({ rule: answer }), { status: 200 })
    }
    return new Response("{}", { status: 404 })
  })
})
afterEach(() => vi.restoreAllMocks())

const asks = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/recording-names"))
const saves = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/recording-names/saved"))
const forgets = () => calls.filter((c) => c.method === "DELETE" && c.url.endsWith("/recording-names/saved"))
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

/** The offer, once the team's saved namings have answered and it may be used. */
async function enabledAsk(): Promise<HTMLElement> {
  return waitFor(() => {
    const ask = screen.getByTestId("recordings-assistant-ask")
    expect(ask).toBeEnabled()
    return ask
  })
}

function review(names: readonly string[] = NAMES, { canAsk = true, onCancel = () => {} }: { canAsk?: boolean; onCancel?: () => void } = {}) {
  return render(
    <RecordingsReview
      projectId="p1"
      canAskAssistant={canAsk}
      file={null}
      projectFiles={[{ id: "mat", name: "Matthew", bookCode: "MAT" } as never]}
      getToken={async () => "file-jwt"}
      lane=""
      languageLabel={null}
      username="lee"
      chosen={chosen(names)}
      onStarted={() => {}}
      onCancel={onCancel}
    />,
  )
}

/** Choose a line, or "Don't upload", for a placed row by hand. */
async function chooseByHand(rowIndex: number, option: string) {
  fireEvent.click(screen.getAllByTestId("recordings-change")[rowIndex])
  const search = await screen.findByRole("combobox", { name: "Search lines" })
  fireEvent.change(search, { target: { value: option } })
  const pick = await waitFor(() => {
    // A line's option reads "Matthew 19:9  <its text>"; "Don't upload" alone.
    const found = screen.getAllByTestId("recordings-line-option").find((o) => {
      const text = o.textContent?.trim() ?? ""
      return text === option || text.startsWith(`${option} `)
    })
    if (!found) throw new Error(`no option ${option}`)
    return found
  })
  fireEvent.click(pick)
}

describe("the assistant is offered, never asked on its own", () => {
  it("offers to work out the naming when none of the known namings fits, and asks nothing yet", async () => {
    review()
    expect(await screen.findByTestId("recordings-assistant-ask")).toBeInTheDocument()
    expect(screen.getAllByTestId("recordings-unmatched-row")).toHaveLength(3)
    expect(asks()).toHaveLength(0)
  })

  it("asks once on a click, sends only names and the outline, and places every file by the rule", async () => {
    review()
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(screen.getAllByTestId("recordings-row")).toHaveLength(3))
    expect(asks()).toHaveLength(1)
    const body = asks()[0].body!
    expect(body.names).toEqual(NAMES)
    expect(String(body.outline)).toContain("MAT (Matthew)")
    expect(JSON.stringify(body)).not.toContain("Matthew 19:1")
    const rows = screen.getAllByTestId("recordings-row")
    expect(rows.map((r) => r.getAttribute("data-target"))).toEqual(["Matthew 19:1", "Matthew 19:2", "Matthew 22:32"])
    expect(within(rows[0]).getByTestId("recordings-how")).toHaveTextContent("by the assistant's rule")
    expect(screen.getByTestId("recordings-assistant-note")).toHaveTextContent("Mt is Matthew")
  })

  it("retries once with only the names the first rule failed on, then stops", async () => {
    answers = [{ ...RULE, books: { Mt: "MRK" } }, { ...RULE, books: { Mt: "MRK" } }]
    review()
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(asks()).toHaveLength(2))
    expect((asks()[1].body!.failures as unknown[]).length).toBe(3)
    await screen.findByTestId("recordings-assistant-problem")
    expect(asks()).toHaveLength(2)
  })

  it("keeps the rule for the team when the upload is confirmed", async () => {
    review()
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(screen.getAllByTestId("recordings-row")).toHaveLength(3))
    fireEvent.click(screen.getByTestId("recordings-confirm"))
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/recording-names/saved"))).toBe(true))
    const save = calls.find((c) => c.method === "POST" && c.url.endsWith("/recording-names/saved"))!
    expect(save.body!.shapes).toEqual(["mt-ch#_v#.ogg"])
    expect(started).toHaveBeenCalledTimes(1)
  })
})

describe("a team's saved rule", () => {
  it("places the files with no call when the names have its shape", async () => {
    saved = { "mt-ch#_v#.ogg": RULE }
    review()
    await waitFor(() => expect(screen.getAllByTestId("recordings-row")).toHaveLength(3))
    expect(asks()).toHaveLength(0)
    expect(within(screen.getAllByTestId("recordings-row")[0]).getByTestId("recordings-how")).toHaveTextContent("by your team's saved rule")
  })

  it("can be set aside, which puts the files back to be chosen by hand", async () => {
    saved = { "mt-ch#_v#.ogg": RULE }
    review()
    fireEvent.click(await screen.findByTestId("recordings-assistant-undo"))
    await waitFor(() => expect(screen.getAllByTestId("recordings-unmatched-row")).toHaveLength(3))
    expect(asks()).toHaveLength(0)
  })
})

describe("at most two calls for a folder (review, Oct 30)", () => {
  it("a failing retry makes exactly two calls, then stops and says the naming didn't fit", async () => {
    answers = [{ ...RULE, books: { Mt: "MRK" } }, FAIL]
    review()
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(asks()).toHaveLength(2))
    await settle(1500)
    expect(asks()).toHaveLength(2)
    expect(await screen.findByTestId("recordings-assistant-problem")).toHaveTextContent("didn't fit")
    expect(screen.queryByTestId("recordings-assistant-ask")).toBeNull()
  })

  it("the retry sends only the names the first rule failed on", async () => {
    answers = [RULE, RULE]
    review(["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg", "Mt-ch19_v99.ogg"])
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(asks()).toHaveLength(2))
    expect(asks()[1].body!.names).toEqual(["Mt-ch19_v99.ogg"])
    expect(asks()[1].body!.failures).toEqual([{ name: "Mt-ch19_v99.ogg", made: "MAT 19:99.ogg", reason: "noSuchVerse" }])
  })

  it("after two calls the offer doesn't come back for that folder", async () => {
    answers = [FAIL, FAIL]
    review()
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(screen.getByTestId("recordings-assistant-problem")).toBeInTheDocument())
    // One call so far: the person may try once more.
    fireEvent.click(screen.getByTestId("recordings-assistant-ask"))
    await waitFor(() => expect(asks()).toHaveLength(2))
    await settle()
    expect(screen.queryByTestId("recordings-assistant-ask")).toBeNull()
    expect(screen.getByTestId("recordings-assistant-problem")).toBeInTheDocument()
    expect(asks()).toHaveLength(2)
  })

  it("stops the request when the person cancels, and when the preview closes", async () => {
    answers = [HANG]
    const { unmount } = review(NAMES, { onCancel: () => {} })
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(asks()).toHaveLength(1))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(asks()[0].signal?.aborted).toBe(true)
    unmount()
    answers = [HANG]
    const again = review()
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(asks()).toHaveLength(2))
    again.unmount()
    expect(asks()[1].signal?.aborted).toBe(true)
  })
})

describe("what goes to the assistant (review, Oct 30)", () => {
  it("never sends a name the app refused on purpose", async () => {
    // Mt-ch19_v99 is read, and refused: Matthew 19 has no verse 99.
    review(["MAT 19-99.ogg", "Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg"])
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(asks()).toHaveLength(1))
    expect(asks()[0].body!.names).toEqual(["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg"])
  })

  it("waits for the team's saved namings before it offers to ask", async () => {
    lookupDelay = 400
    review()
    const ask = await screen.findByTestId("recordings-assistant-ask")
    expect(ask).toBeDisabled()
    await waitFor(() => expect(screen.getByTestId("recordings-assistant-ask")).toBeEnabled(), { timeout: 2000 })
  })
})

describe("a rule is kept for the team only when it truly placed the folder (review, Oct 30)", () => {
  async function askAndConfirm(names: readonly string[], afterPlaced?: () => Promise<void>) {
    review(names)
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(screen.getByTestId("recordings-assistant-note")).toBeInTheDocument())
    await settle()
    await afterPlaced?.()
    fireEvent.click(screen.getByTestId("recordings-confirm"))
    await waitFor(() => expect(started).toHaveBeenCalledTimes(1))
    await settle(100)
  }

  it("keeps a rule that placed every name by reading it", async () => {
    await askAndConfirm(NAMES)
    expect(saves()).toHaveLength(1)
  })

  it("doesn't keep a rule that placed only some names", async () => {
    answers = [RULE, RULE]
    await askAndConfirm(["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg", "Mt-ch19_v99.ogg"])
    expect(asks()).toHaveLength(2)
    expect(saves()).toHaveLength(0)
  })

  it("doesn't keep a rule when the person chose a line by hand", async () => {
    await askAndConfirm(NAMES, () => chooseByHand(0, "Matthew 19:9"))
    expect(saves()).toHaveLength(0)
  })

  it("doesn't keep a rule when the person left a file out", async () => {
    await askAndConfirm(NAMES, () => chooseByHand(2, "Don't upload"))
    expect(saves()).toHaveLength(0)
  })

  it("doesn't keep a rule that leans on a book or chapter it was told", async () => {
    answers = [{ templates: [{ pattern: "Mt-ch19_v{verse}" }], book: "MAT", chapter: 19, explanation: "The verse; Matthew 19 throughout." }]
    await askAndConfirm(["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg"])
    expect(screen.queryAllByTestId("recordings-unmatched-row")).toHaveLength(0)
    expect(saves()).toHaveLength(0)
  })

  it("doesn't keep a rule that puts two files on one line", async () => {
    // Verses 1 to 3, take 1 each, read with the take and the verse swapped:
    // three takes of Matthew 5:1.
    answers = [{ templates: [{ pattern: "{book}-ch{chapter}_v{take}_t{verse}" }], books: { Mt: "MAT" }, explanation: "Swapped." }]
    await askAndConfirm(["Mt-ch5_v1_t1.ogg", "Mt-ch5_v2_t1.ogg", "Mt-ch5_v3_t1.ogg"])
    expect(screen.queryAllByTestId("recordings-unmatched-row")).toHaveLength(0)
    expect(saves()).toHaveLength(0)
  })
})

describe("a contributor, and a saved rule set aside (review, Oct 30)", () => {
  it("shows a contributor one plain line instead of the offer, and never asks", async () => {
    review(NAMES, { canAsk: false })
    expect(await screen.findByTestId("recordings-assistant-lead-only")).toHaveTextContent("A project lead can ask the assistant to work out this naming.")
    expect(screen.queryByTestId("recordings-assistant-ask")).toBeNull()
    await settle()
    expect(asks()).toHaveLength(0)
  })

  it("applies the team's saved rule for a contributor too, with no call", async () => {
    saved = { "mt-ch#_v#.ogg": RULE }
    review(NAMES, { canAsk: false })
    await waitFor(() => expect(screen.getAllByTestId("recordings-row")).toHaveLength(3))
    expect(within(screen.getAllByTestId("recordings-row")[0]).getByTestId("recordings-how")).toHaveTextContent("by your team's saved rule")
    expect(asks()).toHaveLength(0)
  })

  it("forgets a saved rule when a lead sets it aside, so it doesn't stick", async () => {
    saved = { "mt-ch#_v#.ogg": RULE }
    review()
    fireEvent.click(await screen.findByTestId("recordings-assistant-undo"))
    await waitFor(() => expect(forgets()).toHaveLength(1))
    expect(forgets()[0].body).toEqual({ projectId: "p1", shapes: ["mt-ch#_v#.ogg"] })
  })

  it("only sets a saved rule aside for a contributor, who can't change the team's namings", async () => {
    saved = { "mt-ch#_v#.ogg": RULE }
    review(NAMES, { canAsk: false })
    fireEvent.click(await screen.findByTestId("recordings-assistant-undo"))
    await waitFor(() => expect(screen.getAllByTestId("recordings-unmatched-row")).toHaveLength(3))
    await settle()
    expect(forgets()).toHaveLength(0)
  })

  it("only sets a fresh rule aside, and keeps nothing", async () => {
    review()
    fireEvent.click(await enabledAsk())
    fireEvent.click(await screen.findByTestId("recordings-assistant-undo"))
    await waitFor(() => expect(screen.getAllByTestId("recordings-unmatched-row")).toHaveLength(3))
    expect(forgets()).toHaveLength(0)
  })
})
