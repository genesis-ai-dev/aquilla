// OPS-3 (docs/OPSEC-REVIEW-2026-08-13.md): session replay must not carry
// unpublished draft text off our infrastructure.
//
// `maskAllInputs: true` reads like it covers user content, and does not: the
// cell editor is a TipTap contenteditable, not an `<input>`, and the source
// text beside it is plain rendered DOM. So the one surface whose disclosure
// actually matters — which passage a named person is working on, and what they
// have written — was the one surface replay captured verbatim.
//
// The masking now hangs off the `data-cell-type` wrappers in EditorTable, which
// is a selector-to-markup dependency across two files with nothing in the type
// system tying them together. This test is that tie: it fails if the selector
// stops naming the markers, or if the markers disappear from the markup.
//
// Deliberately source-level rather than a render test, for the same reason
// `worker/security-headers.test.ts` parses `public/_headers`: the failure mode
// is drift between two files, and a render test of one of them cannot see it.
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
}

const posthogSource = read("./posthog.ts")
const editorSource = read("../components/EditorTable.tsx")

function maskTextSelector(): string {
  const match = /maskTextSelector:\s*"([^"]+)"/.exec(posthogSource)
  expect(match, "posthog.ts must configure maskTextSelector").toBeTruthy()
  return match![1]
}

describe("session replay masking", () => {
  it("masks the editor's cell-text wrappers", () => {
    const selectors = maskTextSelector().split(",").map((s) => s.trim())
    expect(selectors).toContain("[data-cell-type]")
    expect(selectors).toContain("[data-ph-mask]")
  })

  it("EditorTable still marks both columns with data-cell-type", () => {
    expect(editorSource).toMatch(/data-cell-type="source"/)
    expect(editorSource).toMatch(/data-cell-type="target"/)
  })

  it("comment bodies opt in explicitly — they quote the draft", () => {
    for (const file of ["../components/CommentThread.tsx", "../components/CommentsPage.tsx"]) {
      expect(read(file), `${file} must mask its rendered comment body`).toMatch(/data-ph-mask/)
    }
  })

  it("keeps recording opt-out by default, so masking is the second line and not the first", () => {
    expect(posthogSource).toMatch(/opt_out_capturing_by_default/)
    expect(posthogSource).toMatch(/maskAllInputs:\s*true/)
  })
})
