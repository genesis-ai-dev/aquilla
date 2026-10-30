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

type Route = { method: string; url: string; body: Record<string, unknown> | null }
let calls: Route[] = []
let answers: unknown[] = []
let saved: Record<string, unknown> = {}

beforeEach(() => {
  calls = []
  answers = [RULE]
  saved = {}
  started.mockClear()
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null })
    // Answered a little later, as a real server would: the preview re-renders
    // meanwhile, which once cancelled the saved-rule lookup (Chromium, Oct 30).
    if (url.includes("/recording-names/saved") && method === "GET") {
      await new Promise((r) => setTimeout(r, 30))
      return new Response(JSON.stringify({ rules: saved }), { status: 200 })
    }
    if (url.includes("/recording-names/saved")) return new Response(JSON.stringify({ saved: true }), { status: 200 })
    if (url.includes("/recording-names")) return new Response(JSON.stringify({ rule: answers.shift() ?? RULE }), { status: 200 })
    return new Response("{}", { status: 404 })
  })
})
afterEach(() => vi.restoreAllMocks())

const asks = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/recording-names"))

function review(names = NAMES) {
  return render(
    <RecordingsReview
      projectId="p1"
      file={null}
      projectFiles={[{ id: "mat", name: "Matthew", bookCode: "MAT" } as never]}
      getToken={async () => "file-jwt"}
      lane=""
      languageLabel={null}
      username="lee"
      chosen={chosen(names)}
      onStarted={() => {}}
      onCancel={() => {}}
    />,
  )
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
    fireEvent.click(await screen.findByTestId("recordings-assistant-ask"))
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
    fireEvent.click(await screen.findByTestId("recordings-assistant-ask"))
    await waitFor(() => expect(asks()).toHaveLength(2))
    expect((asks()[1].body!.failures as unknown[]).length).toBe(3)
    await screen.findByTestId("recordings-assistant-problem")
    expect(asks()).toHaveLength(2)
  })

  it("keeps the rule for the team when the upload is confirmed", async () => {
    review()
    fireEvent.click(await screen.findByTestId("recordings-assistant-ask"))
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
