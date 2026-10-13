// Tools builder: what a model reply must look like to be saved, the repair
// message a failing reply produces, and (AQU-1793) the requirements checklist
// + self-review + one fix pass. The model is a stub fetch — the contract under
// test is the pipeline, not the model.

import { describe, it, expect } from "vitest"
import { runBuild, TOOLS_BUILDER_MODEL } from "../lib/tools/builder"
import { TOOLS_BUILDER_SYSTEM_PROMPT, buildUserMessage, parseBuildReply, parseRequirementsBlock } from "../lib/tools/build-prompt"
import { TOOLS_REVIEW_SYSTEM_PROMPT, parseReview, staticUiFindings } from "../lib/tools/build-review"
import { UI_CHECKS } from "../lib/tools/build-prompt-guide"

function stubFetch(contents: string[], cost = 0.12): { fetchImpl: typeof fetch; bodies: { model: string; max_tokens: number; messages: { role: string; content: string }[] }[] } {
  const bodies: { model: string; max_tokens: number; messages: { role: string; content: string }[] }[] = []
  let i = 0
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")))
    const content = contents[Math.min(i++, contents.length - 1)]
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 20, cost } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }) as typeof fetch
  return { fetchImpl, bodies }
}

const REQS = [
  { id: 1, text: "Verses side by side, linked by ref", priority: "must", status: "planned" },
  { id: 2, text: "Show alignment data", priority: "must", status: "not_possible", note: "The bridge has no alignment data." },
]
const reply = (manifest: object, html: string, reqs: object[] = REQS) =>
  "```requirements\n" + JSON.stringify(reqs) + "\n```\nHere you go.\n```json\n" + JSON.stringify(manifest) + "\n```\n```html\n" + html + "\n```\n"
const review = (body: object) => "```review\n" + JSON.stringify(body) + "\n```"

const MANIFEST = { name: "Grid", description: "a grid", scopes: ["read:cells"], mounts: ["page"] }
const CLEAN = `<div class="skel">Loading</div><script>aq.mount(aq.ui.Page({ children: [aq.CellList({})] }))</script>`

describe("tools builder gates", () => {
  it("accepts a clean reply and reports cost (no review)", async () => {
    const { fetchImpl, bodies } = stubFetch([reply(MANIFEST, CLEAN)])
    const out = await runBuild({ OPENROUTER_API_KEY: "k" }, { request: "a grid", review: false }, fetchImpl)
    expect(out.ok).toBe(true)
    expect(out.usage.cost).toBeCloseTo(0.12)
    expect(out.model).toBe(TOOLS_BUILDER_MODEL)
    expect(bodies[0].model).toBe("anthropic/claude-opus-5.5")
    expect(bodies).toHaveLength(1)
  })

  it("fails lint on banned globals and returns a repair message naming them", async () => {
    const { fetchImpl, bodies } = stubFetch([reply(MANIFEST, `<script>fetch("https://x");eval("1")</script>`)])
    const out = await runBuild({ OPENROUTER_API_KEY: "k" }, { request: "a grid" }, fetchImpl)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure).toMatch(/fetch\(\) is not available/)
    expect(out.failure).toMatch(/eval\(\) is banned/)
    expect(out.source).toContain("fetch")
    expect(out.requirements).toHaveLength(2)
    expect(bodies).toHaveLength(1) // no review of a candidate that failed the gates
  })

  it("fails on an unknown scope", async () => {
    const { fetchImpl } = stubFetch([reply({ ...MANIFEST, scopes: ["write:everything"] }, "<script></script>")])
    const out = await runBuild({ OPENROUTER_API_KEY: "k" }, { request: "x" }, fetchImpl)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure).toMatch(/unknown scope: write:everything/)
  })

  it("fails when the reply has no blocks", async () => {
    expect(parseBuildReply("sorry")).toEqual({ error: "reply had no ```json manifest block" })
  })

  it("puts the previous attempt and failure into the repair prompt", () => {
    const msg = buildUserMessage("a grid", { previousSource: "<p>old</p>", previousManifest: "{}", failure: "smoke: boom" })
    expect(msg).toContain("smoke: boom")
    expect(msg).toContain("<p>old</p>")
  })
})

describe("prompt assembly (AQU-1793)", () => {
  it("asks for the requirements checklist before the code, in three blocks", () => {
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toContain("exactly three fenced blocks")
    expect(TOOLS_BUILDER_SYSTEM_PROMPT.indexOf("```requirements")).toBeLessThan(TOOLS_BUILDER_SYSTEM_PROMPT.indexOf("```html\n<!doctype"))
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toMatch(/"not_possible"/)
  })

  it("carries the design rules, mount choice and domain grounding", () => {
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toMatch(/Do NOT draw\s+your own title/)
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toMatch(/never contradicts|Never write copy the UI then\s+contradicts/)
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toMatch(/skeleton in the STATIC HTML/)
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toMatch(/Never add "panel" to a wide multi-column layout/)
    // Viewing alignments is buildable via Door43; saving them is stated as not possible, with the reason.
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toMatch(/SAVING alignments[\s\S]*no shared storage for extension data/)
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toMatch(/word-level ALIGNMENTS \(read from the aligned USFM\)/)
    // Data a project has only if it imported it is "partial", never silently "covered".
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toMatch(/only when the project has imported the data[\s\S]*"partial"/)
    expect(TOOLS_REVIEW_SYSTEM_PROMPT).toMatch(/imported that data as a file[\s\S]*"partial"/)
  })

  it("documents read:web and Door43's layout (raw URLs, TSV columns, aligned USFM)", () => {
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toContain("aquilla.web.fetch(url")
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toContain('"web": ["git.door43.org"]')
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toContain("https://git.door43.org/unfoldingWord/<repo>/raw/branch/master/<path>")
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toContain("Reference, ID, Tags, SupportReference, Quote, Occurrence, Note")
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toContain("Reference, ID, Tags, OrigWords, Occurrence, TWLink")
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toMatch(/\\zaln-s \|x-strong=/)
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toContain("bible/kt/<word>.md")
  })

  it("no SDK example draws a title the host already shows", () => {
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).not.toMatch(/aq\.ui\.(Page|Panel)\(\{ title: "/)
  })

  it("the review prompt lists every UI check and the domain limits", () => {
    for (const c of UI_CHECKS) expect(TOOLS_REVIEW_SYSTEM_PROMPT).toContain(c)
    expect(TOOLS_REVIEW_SYSTEM_PROMPT).toMatch(/SAVING alignments/)
  })

  it("an edit lists only the change's requirements", () => {
    expect(buildUserMessage("add totals", undefined, { source: "<p/>", manifest: "{}" })).toContain("only this change's requirements")
  })
})

describe("requirements pass", () => {
  it("parses and normalizes the requirements block; a malformed one is ignored", () => {
    const reqs = parseRequirementsBlock(reply(MANIFEST, CLEAN))
    expect(reqs).toEqual([
      { id: 1, text: "Verses side by side, linked by ref", priority: "must", status: "planned" },
      { id: 2, text: "Show alignment data", priority: "must", status: "not_possible", note: "The bridge has no alignment data." },
    ])
    expect(parseRequirementsBlock("```requirements\nnot json\n```")).toEqual([])
    expect(parseRequirementsBlock("no block")).toEqual([])
  })

  it("reviews, re-marks the checklist, and keeps the build when nothing needs fixing", async () => {
    const { fetchImpl, bodies } = stubFetch([
      reply(MANIFEST, CLEAN),
      review({ requirements: [{ id: 1, status: "covered", note: "Columns joined by ref" }, { id: 2, status: "not_possible", note: "No alignment API." }], ui: [{ check: "no-duplicate-header", ok: true }], fix: null }),
    ])
    const out = await runBuild({ OPENROUTER_API_KEY: "k" }, { request: "tracks" }, fetchImpl)
    expect(bodies).toHaveLength(2)
    expect(bodies[1].messages[0].content).toBe(TOOLS_REVIEW_SYSTEM_PROMPT)
    expect(bodies[1].max_tokens).toBeLessThan(bodies[0].max_tokens)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.requirements.map((r) => r.status)).toEqual(["covered", "not_possible"])
    expect(out.requirements[1].note).toBe("No alignment API.")
    expect(out.review).toMatchObject({ reviewed: true, fixed: false })
    expect(out.usage.cost).toBeCloseTo(0.24)
  })

  it("applies one fix pass when a must is missing or a UI check fails, and keeps the fix's statuses", async () => {
    const fixed = `<div class="skel">Loading</div><script>aq.mount(aq.ui.Page({ children: [aq.CellList({ row: (id) => aq.CellRow(id) })] }))</script>`
    const { fetchImpl, bodies } = stubFetch([
      reply(MANIFEST, `<h1>Grid</h1>${CLEAN}`),
      review({ requirements: [{ id: 1, status: "missing", note: "No columns" }], ui: [{ check: "no-duplicate-header", ok: false, note: "h1 Grid" }], fix: "1. Remove the <h1>. 2. Add the ref-joined columns." }),
      reply(MANIFEST, fixed, [{ id: 1, text: "Verses side by side, linked by ref", priority: "must", status: "covered" }]),
    ])
    const out = await runBuild({ OPENROUTER_API_KEY: "k" }, { request: "tracks" }, fetchImpl)
    expect(bodies).toHaveLength(3)
    expect(bodies[1].messages[1].content).toContain("no-duplicate-header") // the static finding is passed to the review
    expect(bodies[2].messages[1].content).toContain("Remove the <h1>")
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.source).toBe(fixed)
    // The fix's checklist is taken as written (its ids/rows may differ from the plan's).
    expect(out.requirements).toEqual([{ id: 1, text: "Verses side by side, linked by ref", priority: "must", status: "covered" }])
    expect(out.review.fixed).toBe(true)
  })

  it("keeps the reviewed original when the fix fails the gates", async () => {
    const { fetchImpl } = stubFetch([
      reply(MANIFEST, CLEAN),
      review({ requirements: [{ id: 1, status: "partial" }], ui: [], fix: "Add columns." }),
      reply(MANIFEST, `<script>eval("x")</script>`),
    ])
    const out = await runBuild({ OPENROUTER_API_KEY: "k" }, { request: "tracks" }, fetchImpl)
    expect(out.ok && out.source).toBe(CLEAN)
    expect(out.ok && out.review.fixed).toBe(false)
    expect(out.ok && out.requirements[0].status).toBe("partial")
  })

  it("an unreadable review leaves the build unreviewed, never failed", async () => {
    const { fetchImpl } = stubFetch([reply(MANIFEST, CLEAN), "I think it looks fine"])
    const out = await runBuild({ OPENROUTER_API_KEY: "k" }, { request: "tracks" }, fetchImpl)
    expect(out.ok).toBe(true)
    expect(out.ok && out.review.reviewed).toBe(false)
  })

  it("a reply cut off at the output limit asks the repair for a smaller tool", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "```json\n{}\n```\n```html\n<div>" }, finish_reason: "length" }], usage: { cost: 0.3 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch
    const out = await runBuild({ OPENROUTER_API_KEY: "k" }, { request: "big" }, fetchImpl)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.failure).toMatch(/cut off at the output limit/)
  })

  it("repairs skip the review", async () => {
    const { fetchImpl, bodies } = stubFetch([reply(MANIFEST, CLEAN)])
    await runBuild({ OPENROUTER_API_KEY: "k" }, { request: "x", repair: { previousSource: "", previousManifest: "{}", failure: "smoke" } }, fetchImpl)
    expect(bodies).toHaveLength(1)
  })
})

describe("static UI findings", () => {
  it("flags a duplicate title, contradictory save copy, no skeleton and hand-rolled cell UI", () => {
    const src = `<body><header><h1>Verse Tracks</h1><div>Changes save automatically. There is no Save button.</div></header>
      <script>const cells = await aquilla.cells.list(f); b.innerHTML = '<button>Done</button>'</script></body>`
    const found = staticUiFindings(src, { name: "Verse Tracks" }).join("\n")
    expect(found).toMatch(/no-duplicate-header/)
    expect(found).toMatch(/honest-copy/)
    expect(found).toMatch(/loading-skeleton/)
    expect(found).toMatch(/sdk-components/)
  })

  it("passes an SDK build with a skeleton", () => {
    expect(staticUiFindings(`<body><div class="skel"></div><script>aq.mount(aq.CellList({}))</script></body>`, { name: "Grid" })).toEqual([])
  })

  it("parseReview tolerates partial rows", () => {
    expect(parseReview(review({ requirements: [{ id: 3, status: "covered" }], ui: [{ check: "x" }], fix: "" }))).toEqual({
      requirements: [{ id: 3, text: "·", priority: "must", status: "covered" }],
      ui: [{ check: "x", ok: true }],
      fix: null,
    })
    expect(parseReview("nope")).toBeNull()
  })
})
