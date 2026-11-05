// AQU-2302: the assistant works out a folder's naming only when the person
// asks, once, with one retry at most; the rule it gives is applied and checked
// here, and a team's saved rule is used with no call at all.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
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

import { loadTargetFile } from "@/lib/audio/bulk-upload/load-targets"
import { RecordingsReview } from "./RecordingsUpload"

const RULE = {
  templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }],
  books: { Mt: "MAT" },
  explanation: "Mt is Matthew; then the chapter and the verse.",
}

const NAMES = ["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg", "Mt-ch22_v32.ogg"]
/** A folder close together, as a team's own reading lands it: the kind the
 *  team may keep (review, Oct 30: a sparse or scattered one isn't). */
const DENSE = ["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg", "Mt-ch19_v03.ogg"]
/** A usable rule that fits none of the Mt-ch names (the scripted model's own). */
const NO_FIT = { templates: [{ pattern: "rec-{verse}" }], book: "MAT", chapter: 1, explanation: "rec- then the verse." }

function chosen(names: readonly string[]) {
  return names.map((name) => ({ file: new File([new Uint8Array(16)], name, { type: "audio/ogg" }), path: `Files/${name}` }))
}

type Route = { method: string; url: string; body: Record<string, unknown> | null; signal: AbortSignal | null; headers: Headers }
/** An answer that fails, and one that never comes until the request is aborted. */
const FAIL = Symbol("fail")
const HANG = Symbol("hang")
let calls: Route[] = []
let answers: unknown[] = []
let saved: Record<string, unknown> = {}
let lookupDelay = 30
/** What the server says about keeping and forgetting the team's namings. */
let canKeep: boolean | undefined = true
let forgetAnswer: "ok" | "refused" | "offline" = "ok"

beforeEach(() => {
  calls = []
  answers = [RULE]
  saved = {}
  lookupDelay = 30
  canKeep = true
  forgetAnswer = "ok"
  started.mockClear()
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null, signal: init?.signal ?? null, headers: new Headers(init?.headers) })
    // Answered a little later, as a real server would: the preview re-renders
    // meanwhile, which once cancelled the saved-rule lookup (Chromium, Oct 30).
    if (url.includes("/recording-names/saved") && method === "GET") {
      if (lookupDelay === Infinity) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        })
      }
      await new Promise((r) => setTimeout(r, lookupDelay))
      return new Response(JSON.stringify({ rules: saved, canKeep }), { status: 200 })
    }
    if (url.includes("/recording-names/saved") && method === "DELETE") {
      if (forgetAnswer === "offline") throw new TypeError("Failed to fetch")
      if (forgetAnswer === "refused") return new Response(JSON.stringify({ error: "org_member_required" }), { status: 403 })
      return new Response(JSON.stringify({ forgotten: true }), { status: 200 })
    }
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
    answers = [NO_FIT, NO_FIT]
    review()
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(asks()).toHaveLength(2))
    expect((asks()[1].body!.failures as unknown[]).length).toBe(3)
    await screen.findByTestId("recordings-assistant-problem")
    expect(asks()).toHaveLength(2)
  })

  it("keeps the rule for the team when the upload is confirmed", async () => {
    review(DENSE)
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(screen.getAllByTestId("recordings-row")).toHaveLength(3))
    fireEvent.click(screen.getByTestId("recordings-confirm"))
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/recording-names/saved"))).toBe(true))
    const save = calls.find((c) => c.method === "POST" && c.url.endsWith("/recording-names/saved"))!
    expect(save.body!.shapes).toEqual(["mt-ch#_v#"])
    expect(started).toHaveBeenCalledTimes(1)
  })
})

describe("a team's saved rule", () => {
  it("places the files with no call when the names have its shape", async () => {
    saved = { "mt-ch#_v#": RULE }
    review()
    await waitFor(() => expect(screen.getAllByTestId("recordings-row")).toHaveLength(3))
    expect(asks()).toHaveLength(0)
    expect(within(screen.getAllByTestId("recordings-row")[0]).getByTestId("recordings-how")).toHaveTextContent("by your team's saved rule")
  })

  it("can be set aside, which puts the files back to be chosen by hand", async () => {
    saved = { "mt-ch#_v#": RULE }
    review()
    fireEvent.click(await screen.findByTestId("recordings-assistant-undo"))
    await waitFor(() => expect(screen.getAllByTestId("recordings-unmatched-row")).toHaveLength(3))
    expect(asks()).toHaveLength(0)
  })
})

describe("at most two calls for a folder (review, Oct 30)", () => {
  it("a failing retry makes exactly two calls, then stops and says the naming didn't fit", async () => {
    answers = [NO_FIT, FAIL]
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
    await askAndConfirm(DENSE)
    expect(saves()).toHaveLength(1)
  })

  it("doesn't keep a rule that placed only some names", async () => {
    answers = [RULE, RULE]
    await askAndConfirm(["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg", "Mt-ch19_v99.ogg"])
    expect(asks()).toHaveLength(2)
    expect(saves()).toHaveLength(0)
  })

  it("doesn't keep a rule when the person chose a line by hand", async () => {
    await askAndConfirm(DENSE, () => chooseByHand(0, "Matthew 19:9"))
    expect(saves()).toHaveLength(0)
  })

  it("doesn't keep a rule when the person left a file out", async () => {
    await askAndConfirm(DENSE, () => chooseByHand(2, "Don't upload"))
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

  it("keeps a pieces naming that placed every name: 4a and 4b are two pieces of Matthew 19:4 (Sam, Oct 30)", async () => {
    answers = [{
      templates: [{ pattern: "{book}-ch{chapter}_v{verse}{part}" }, { pattern: "{book}-ch{chapter}_v{verse}" }],
      books: { Mt: "MAT" },
      explanation: "Mt is Matthew; the chapter, the verse, and a letter for each piece.",
    }]
    await askAndConfirm(["Mt-ch19_v03.ogg", "Mt-ch19_v04a.ogg", "Mt-ch19_v04b.ogg"], async () => {
      const rows = screen.getAllByTestId("recordings-row")
      expect(rows.map((r) => within(r).getByTestId("recordings-how").textContent)).toEqual([
        "by the assistant's rule",
        "by the assistant's rule · part 1 of 2",
        "by the assistant's rule · part 2 of 2",
      ])
    })
    expect(saves()).toHaveLength(1)
    expect(saves()[0].body!.shapes).toEqual(["mt-ch#_v#", "mt-ch#_v#a", "mt-ch#_v#b"])
  })
})

describe("a retry that does worse doesn't win (Sam, Oct 30)", () => {
  // Read the right way round, and with the chapter and the verse swapped
  // (Mt-ch19_v01 as Matthew 1:19): a model's likely slip on a retry.
  const RIGHT = { ...RULE, explanation: "The chapter, then the verse." }
  const SWAPPED = { templates: [{ pattern: "{book}-ch{verse}_v{chapter}" }], books: { Mt: "MAT" }, explanation: "The verse, then the chapter." }

  async function askTwice(names: readonly string[]) {
    review(names)
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(asks()).toHaveLength(2))
    await waitFor(() => expect(screen.getByTestId("recordings-assistant-note")).toBeInTheDocument())
    await settle()
  }
  const targets = () => screen.getAllByTestId("recordings-row").map((r) => r.getAttribute("data-target"))
  /** Every line a row was ever put on, even for one render: what the person
   *  could have seen, and confirmed. */
  function everShown(): () => string[] {
    const seen = new Set<string>()
    const rowsIn = (node: Node) => node instanceof Element
      ? [...(node.matches("[data-testid=recordings-row]") ? [node] : []), ...node.querySelectorAll("[data-testid=recordings-row]")]
      : []
    const look = (records: MutationRecord[]) => {
      // A row is new, or a row kept by React is moved to another line.
      for (const record of records) {
        if (record.type === "attributes" && record.oldValue) seen.add(record.oldValue)
        for (const row of [...[...record.addedNodes].flatMap(rowsIn), ...(record.type === "attributes" ? rowsIn(record.target) : [])]) {
          seen.add(row.getAttribute("data-target") ?? "")
        }
      }
      for (const row of rowsIn(document.body)) seen.add(row.getAttribute("data-target") ?? "")
    }
    const observer = new MutationObserver(look)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-target"], attributeOldValue: true })
    return () => { look(observer.takeRecords()); observer.disconnect(); return [...seen].sort() }
  }
  const marked = () => screen.getAllByTestId("recordings-row").filter((r) => within(r).getByTestId("recordings-how").textContent === "by the assistant's rule").length

  it("keeps the first rule when the retry's places fewer of the folder's names, and asks nothing more", async () => {
    // The first places 19:1, 19:2 and 19:30, and not 19:99. Swapped, the
    // retry places only 1:19 and 2:19 (Matthew has no chapter 30 or 99).
    answers = [RIGHT, SWAPPED]
    const shown = everShown()
    await askTwice(["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg", "Mt-ch19_v30.ogg", "Mt-ch19_v99.ogg"])
    expect(targets()).toEqual(["Matthew 19:1", "Matthew 19:2", "Matthew 19:30"])
    // The swapped rule's rows (Matthew 1:19, 2:19) never showed, not even
    // while it was weighed.
    expect(shown()).toEqual(["Matthew 19:1", "Matthew 19:2", "Matthew 19:30"])
    expect(marked()).toBe(3)
    const note = screen.getByTestId("recordings-assistant-note")
    expect(note).toHaveTextContent("The chapter, then the verse.")
    expect(note).toHaveTextContent("3 recordings are placed by this naming.")
    expect(screen.getAllByTestId("recordings-unmatched-row").map((r) => r.getAttribute("data-name"))).toEqual(["Mt-ch19_v99.ogg"])
    await settle(500)
    expect(asks()).toHaveLength(2)
    // The first rule missed a name, so it isn't kept.
    fireEvent.click(screen.getByTestId("recordings-confirm"))
    await waitFor(() => expect(started).toHaveBeenCalledTimes(1))
    await settle(100)
    expect(saves()).toHaveLength(0)
  })

  it("keeps the first rule on a tie", async () => {
    // Both place two: 19:1 and 19:2 the right way round, 1:19 and 2:19 swapped.
    answers = [RIGHT, SWAPPED]
    await askTwice(["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg", "Mt-ch19_v99.ogg"])
    expect(targets()).toEqual(["Matthew 19:1", "Matthew 19:2"])
    expect(marked()).toBe(2)
    expect(screen.getByTestId("recordings-assistant-note")).toHaveTextContent("The chapter, then the verse.")
    await settle(500)
    expect(asks()).toHaveLength(2)
  })

  it("uses a retry that places more, and keeps it when it placed every name", async () => {
    // Swapped first: 1:19 and 2:19, not 3:19 (Matthew 3 has 17 verses). The
    // retry places all three.
    answers = [SWAPPED, RIGHT]
    await askTwice(DENSE)
    expect(targets()).toEqual(["Matthew 19:1", "Matthew 19:2", "Matthew 19:3"])
    expect(marked()).toBe(3)
    expect(screen.getByTestId("recordings-assistant-note")).toHaveTextContent("The chapter, then the verse.")
    await settle(500)
    expect(asks()).toHaveLength(2)
    fireEvent.click(screen.getByTestId("recordings-confirm"))
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect(saves()[0].body!.rule).toMatchObject({ templates: RIGHT.templates })
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
    saved = { "mt-ch#_v#": RULE }
    review(NAMES, { canAsk: false })
    await waitFor(() => expect(screen.getAllByTestId("recordings-row")).toHaveLength(3))
    expect(within(screen.getAllByTestId("recordings-row")[0]).getByTestId("recordings-how")).toHaveTextContent("by your team's saved rule")
    expect(asks()).toHaveLength(0)
  })

  it("sets a saved rule aside for this upload only when a lead says not to use it (review, Oct 30)", async () => {
    saved = { "mt-ch#_v#": RULE }
    review()
    fireEvent.click(await screen.findByTestId("recordings-assistant-undo"))
    await waitFor(() => expect(screen.getAllByTestId("recordings-unmatched-row")).toHaveLength(3))
    await settle()
    expect(forgets()).toHaveLength(0)
    // The offer is back for the names, so the lead can ask instead.
    expect(await enabledAsk()).toBeInTheDocument()
  })

  it("forgets a saved rule for the team only on its own plainly labelled button, for a lead (review, Oct 30)", async () => {
    saved = { "mt-ch#_v#": RULE }
    review()
    const forget = await screen.findByTestId("recordings-assistant-forget")
    expect(forget).toHaveTextContent("Forget this naming for the team")
    fireEvent.click(forget)
    await waitFor(() => expect(forgets()).toHaveLength(1))
    expect(forgets()[0].body).toEqual({ projectId: "p1", shapes: ["mt-ch#_v#"] })
    await waitFor(() => expect(screen.getAllByTestId("recordings-unmatched-row")).toHaveLength(3))
  })

  it("only sets a saved rule aside for a contributor, who can't change the team's namings", async () => {
    saved = { "mt-ch#_v#": RULE }
    review(NAMES, { canAsk: false })
    await screen.findByTestId("recordings-assistant-undo")
    expect(screen.queryByTestId("recordings-assistant-forget")).toBeNull()
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

// ── The second review (Oct 30) ──────────────────────────────────────────────

describe("a saved rule that places only part of a folder (review, Oct 30)", () => {
  const PARTLY = ["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg", "rec-03.ogg"]
  // rec-03 read as Matthew 19:3 by a second template, with the book and the
  // chapter as constants.
  const BOTH = {
    templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }, { pattern: "rec-{verse}" }],
    books: { Mt: "MAT" },
    book: "MAT",
    chapter: 19,
    explanation: "Both namings.",
  }

  it("still offers the lead the assistant for the names it left, and asks nothing on its own", async () => {
    saved = { "mt-ch#_v#": RULE }
    review(PARTLY)
    await waitFor(() => expect(screen.getAllByTestId("recordings-row")).toHaveLength(2))
    expect(screen.getAllByTestId("recordings-unmatched-row")).toHaveLength(1)
    expect(screen.getByTestId("recordings-assistant-note")).toHaveTextContent("Read with your team's saved naming")
    expect(await enabledAsk()).toBeInTheDocument()
    expect(screen.getByTestId("recordings-assistant")).toHaveTextContent("fits 1 of these recordings")
    await settle()
    expect(asks()).toHaveLength(0)
  })

  it("asks like the retry: the saved rule as the one tried, and only the names it left", async () => {
    saved = { "mt-ch#_v#": RULE }
    // An answer that reads rec-03 no better: a tie, so the saved rule stays.
    answers = [{ ...RULE, templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }, { pattern: "rec-{verse}" }], explanation: "Both namings." }]
    review(PARTLY)
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(asks()).toHaveLength(1))
    expect(asks()[0].body!.names).toEqual(["rec-03.ogg"])
    expect(asks()[0].body!.previous).toMatchObject({ templates: RULE.templates })
    expect(asks()[0].body!.failures).toEqual([{ name: "rec-03.ogg", made: null, reason: "noBook" }])
    await waitFor(() => expect(screen.getByTestId("recordings-assistant-note")).toHaveTextContent("Read with your team's saved naming"))
    await settle()
    expect(asks()).toHaveLength(1)
  })

  it("keeps the saved rule when the answer places fewer, and makes no further call", async () => {
    saved = { "mt-ch#_v#": RULE }
    answers = [NO_FIT, RULE]
    review(PARTLY)
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(asks()).toHaveLength(1))
    await waitFor(() => expect(screen.getByTestId("recordings-assistant-note")).toHaveTextContent("Read with your team's saved naming"))
    await settle(500)
    expect(screen.getAllByTestId("recordings-row").map((r) => r.getAttribute("data-target"))).toEqual(["Matthew 19:1", "Matthew 19:2"])
    expect(asks()).toHaveLength(1)
    expect(screen.queryByTestId("recordings-assistant-ask")).toBeNull()
  })

  it("uses an answer that places more than the saved rule", async () => {
    saved = { "mt-ch#_v#": RULE }
    answers = [BOTH]
    review(["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg", "rec-03.ogg"])
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(screen.getByTestId("recordings-assistant-note")).toHaveTextContent("Both namings."))
    await settle()
    expect(screen.getAllByTestId("recordings-row").map((r) => r.getAttribute("data-target"))).toEqual(["Matthew 19:1", "Matthew 19:2", "Matthew 19:3"])
    expect(asks()).toHaveLength(1)
  })
})

describe("smaller review items (review, Oct 30)", () => {
  it("doesn't keep a rule whose book word names no book, though it placed the folder", async () => {
    answers = [{ templates: [{ pattern: "{book}_{chapter}_{verse}" }], books: { sermon: "MAT" }, explanation: "sermon is Matthew." }]
    review(["sermon_05_01.ogg", "sermon_05_02.ogg", "sermon_05_03.ogg"])
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(screen.getAllByTestId("recordings-row")).toHaveLength(3))
    await settle()
    fireEvent.click(screen.getByTestId("recordings-confirm"))
    await waitFor(() => expect(started).toHaveBeenCalledTimes(1))
    await settle(100)
    expect(saves()).toHaveLength(0)
  })

  it("keeps a word the project's own Bible file is called, read with the project's files as the server reads them", async () => {
    answers = [{ templates: [{ pattern: "{book}x{chapter}x{verse}" }], books: { Mateo: "MAT" }, explanation: "Mateo is Matthew." }]
    render(
      <RecordingsReview
        projectId="p1"
        canAskAssistant
        file={null}
        projectFiles={[{ id: "mat", name: "Mateo", bookCode: "MAT" } as never]}
        getToken={async () => "file-jwt"}
        lane=""
        languageLabel={null}
        username="lee"
        chosen={chosen(["Mateox05x01.ogg", "Mateox05x02.ogg"])}
        onStarted={() => {}}
        onCancel={() => {}}
      />,
    )
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(screen.getAllByTestId("recordings-row")).toHaveLength(2))
    await settle()
    fireEvent.click(screen.getByTestId("recordings-confirm"))
    await waitFor(() => expect(saves()).toHaveLength(1))
  })

  it("sends a fresh Idempotency-Key with each ask, so the server's guard against a double run is used", async () => {
    answers = [NO_FIT, NO_FIT]
    review()
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(asks()).toHaveLength(2))
    const keys = asks().map((c) => c.headers.get("Idempotency-Key"))
    expect(keys.every((k) => typeof k === "string" && k.length >= 16)).toBe(true)
    expect(new Set(keys).size).toBe(2)
  })

  it("enables the offer when the team's saved namings don't answer within about eight seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      lookupDelay = Infinity
      review()
      const ask = await screen.findByTestId("recordings-assistant-ask")
      expect(ask).toBeDisabled()
      await act(async () => { await vi.advanceTimersByTimeAsync(8_100) })
      expect(screen.getByTestId("recordings-assistant-ask")).toBeEnabled()
      expect(calls.find((c) => c.method === "GET" && c.url.includes("/recording-names/saved"))!.signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("applies a saved rule kept from .ogg recordings to the same naming in .mp3", async () => {
    saved = { "mt-ch#_v#": RULE }
    review(NAMES.map((n) => n.replace(".ogg", ".mp3")))
    await waitFor(() => expect(screen.getAllByTestId("recordings-row")).toHaveLength(3))
    expect(asks()).toHaveLength(0)
  })

  it("says in the (i) that a rule is kept only when the names say the book and chapter and every file was placed", async () => {
    review()
    await enabledAsk()
    fireEvent.click(screen.getByRole("button", { name: "About working out the naming" }))
    expect(screen.getByText(/keeps the rule only when the names say the book and the chapter and it placed every file/)).toBeInTheDocument()
  })

  it("reads each project file's lines once per dialog, however often a rule is applied", async () => {
    vi.mocked(loadTargetFile).mockClear()
    // The first rule misses v99, so a retry follows; the tie then sets the
    // first rule back: three readings of the names, one of Matthew's lines.
    answers = [RULE, RULE]
    review(["Mt-ch19_v01.ogg", "Mt-ch19_v02.ogg", "Mt-ch19_v99.ogg"])
    fireEvent.click(await enabledAsk())
    await waitFor(() => expect(asks()).toHaveLength(2))
    await waitFor(() => expect(screen.getByTestId("recordings-assistant-note")).toBeInTheDocument())
    await settle()
    expect(screen.getAllByTestId("recordings-row")).toHaveLength(2)
    expect(vi.mocked(loadTargetFile)).toHaveBeenCalledTimes(1)
  })
})

// Sam, Oct 30: "Forget this naming for the team" only for someone the server
// will let forget it, and a plain word when it didn't go through.
describe("forgetting a team's naming", () => {
  it("doesn't offer Forget to a lead the server won't let forget it, only Don't use", async () => {
    saved = { "mt-ch#_v#": RULE }
    canKeep = false
    review()
    await screen.findByTestId("recordings-assistant-undo")
    await settle()
    expect(screen.queryByTestId("recordings-assistant-forget")).toBeNull()
  })

  it("doesn't offer Forget before the server has said", async () => {
    saved = { "mt-ch#_v#": RULE }
    canKeep = undefined
    review()
    await screen.findByTestId("recordings-assistant-undo")
    await settle()
    expect(screen.queryByTestId("recordings-assistant-forget")).toBeNull()
  })

  for (const failure of ["refused", "offline"] as const) {
    it(`says the naming wasn't forgotten, and keeps it in use, when the server ${failure === "refused" ? "refuses" : "can't be reached"}`, async () => {
      saved = { "mt-ch#_v#": RULE }
      forgetAnswer = failure
      review()
      fireEvent.click(await screen.findByTestId("recordings-assistant-forget"))
      expect(await screen.findByTestId("recordings-assistant-forget-failed")).toHaveTextContent("The naming wasn't forgotten, so your team still has it.")
      expect(forgets()).toHaveLength(1)
      const rows = screen.getAllByTestId("recordings-row")
      expect(rows).toHaveLength(3)
      expect(within(rows[0]).getByTestId("recordings-how")).toHaveTextContent("by your team's saved rule")
      expect(screen.queryAllByTestId("recordings-unmatched-row")).toHaveLength(0)
      expect(screen.getByTestId("recordings-assistant-forget")).toBeEnabled()
    })
  }

  it("sets the naming aside only once the server has forgotten it", async () => {
    saved = { "mt-ch#_v#": RULE }
    review()
    fireEvent.click(await screen.findByTestId("recordings-assistant-forget"))
    await waitFor(() => expect(screen.getAllByTestId("recordings-unmatched-row")).toHaveLength(3))
    expect(screen.queryByTestId("recordings-assistant-forget-failed")).toBeNull()
  })
})

// Sam, Oct 30: one quiet line under the assistant's note says whether the
// team will keep the naming, and an (i) says why not.
describe("whether the naming will be kept", () => {
  const keepLine = () => screen.findByTestId("recordings-assistant-keep")
  const CONSTANT = { templates: [{ pattern: "sermon_{verse}" }], book: "MAT", chapter: 20, explanation: "Every recording is Matthew 20." }

  it("says the team will keep a naming it will keep", async () => {
    review(DENSE)
    fireEvent.click(await enabledAsk())
    const line = await keepLine()
    expect(line).toHaveTextContent("Your team will keep this naming for next time.")
    expect(line).toHaveAttribute("data-keep", "true")
    expect(screen.queryByTestId("recordings-assistant-why-toggle")).toBeNull()
  })

  it("says a naming is for this upload only, with the reason behind an (i) that opens in place", async () => {
    answers = [CONSTANT]
    review(["sermon_01.ogg", "sermon_02.ogg"])
    fireEvent.click(await enabledAsk())
    const line = await keepLine()
    expect(line).toHaveTextContent("This naming is used for this upload only.")
    expect(line).toHaveAttribute("data-keep", "false")
    const why = screen.getByTestId("recordings-assistant-why")
    expect(why).toHaveAttribute("data-open", "false")
    const toggle = screen.getByTestId("recordings-assistant-why-toggle")
    expect(toggle).toHaveAccessibleName("Why this naming isn't kept")
    fireEvent.click(toggle)
    expect(why).toHaveAttribute("data-open", "true")
    expect(why).toHaveTextContent("The names don't say the book and the chapter themselves.")
    fireEvent.click(toggle)
    expect(why).toHaveAttribute("data-open", "false")
  })

  it("gives a made-up book word as the reason", async () => {
    answers = [{ templates: [{ pattern: "{book}-ch{chapter}_v{verse}" }], books: { Sermon: "MAT" }, explanation: "Sermon is Matthew." }]
    review(["Sermon-ch20_v01.ogg", "Sermon-ch20_v02.ogg"])
    fireEvent.click(await enabledAsk())
    await keepLine()
    expect(screen.getByTestId("recordings-assistant-why")).toHaveTextContent("A word in the names stands for a book here, but it isn't a name of that book.")
  })

  it("gives files out of order or scattered as the reason", async () => {
    answers = [{ templates: [{ pattern: "{book}-ch{verse}_v{chapter}" }], books: { Mt: "MAT" }, explanation: "The verse, then the chapter." }]
    review(["Mt-ch05_v01.ogg", "Mt-ch05_v02.ogg", "Mt-ch05_v03.ogg"])
    fireEvent.click(await enabledAsk())
    await keepLine()
    expect(screen.getByTestId("recordings-assistant-why")).toHaveTextContent("The recordings didn't land in order on lines close together")
  })

  it("changes to this upload only when a line is chosen by hand", async () => {
    review(DENSE)
    fireEvent.click(await enabledAsk())
    expect(await keepLine()).toHaveAttribute("data-keep", "true")
    await chooseByHand(1, "Matthew 19:9")
    await waitFor(() => expect(screen.getByTestId("recordings-assistant-keep")).toHaveAttribute("data-keep", "false"))
    expect(screen.getByTestId("recordings-assistant-why")).toHaveTextContent("Not every recording was placed by reading its name.")
  })

  it("tells a lead who isn't in the organization that it's for this upload only, and keeps nothing", async () => {
    canKeep = false
    review(DENSE)
    fireEvent.click(await enabledAsk())
    expect(await keepLine()).toHaveTextContent("This naming is used for this upload only.")
    expect(screen.getByTestId("recordings-assistant-why")).toHaveTextContent("Only a project lead who is also in the project's organization can keep a naming for the team.")
    fireEvent.click(screen.getByTestId("recordings-confirm"))
    await waitFor(() => expect(started).toHaveBeenCalled())
    await settle()
    expect(saves()).toHaveLength(0)
  })

  it("says nothing about keeping a naming the team already keeps", async () => {
    saved = { "mt-ch#_v#": RULE }
    review()
    await screen.findByTestId("recordings-assistant-note")
    await settle()
    expect(screen.queryByTestId("recordings-assistant-keep")).toBeNull()
  })
})
