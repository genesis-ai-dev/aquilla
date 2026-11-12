// Unit tests for the TaBiThA Copilot client (lib/tabitha/client.ts).
//
// WHY: the upstream is an unversioned NDJSON stream built for TaBiThA's own
// UIs. These freeze what the Verse Resources panel depends on: we address it
// only by allowlisted book names (no SSRF), an unknown verse reads as "no
// notes" rather than a failure, and malformed fields degrade instead of throw.

import { describe, it, expect } from "vitest"
import { copilotVerseUrl, parseCopilotStream } from "../lib/tabitha/client"

describe("copilotVerseUrl", () => {
  it("maps USFM codes to the names TaBiThA resolves", () => {
    expect(copilotVerseUrl("1SA", 1, 1)).toBe("https://copilot.tabitha.bible/1%20Samuel/1/1")
    // TaBiThA only accepts "Song of Solomon", not "Song of Songs".
    expect(copilotVerseUrl("sng", 2, 3)).toBe("https://copilot.tabitha.bible/Song%20of%20Solomon/2/3")
  })

  it("rejects unknown books and non-positive numbers", () => {
    expect(copilotVerseUrl("XYZ", 1, 1)).toBeNull()
    expect(copilotVerseUrl("GEN", 0, 1)).toBeNull()
    expect(copilotVerseUrl("GEN", 1, Number.NaN)).toBeNull()
  })
})

describe("parseCopilotStream", () => {
  it("skips progress lines and returns the brief", () => {
    const body = [
      `{"type":"step","step":"notes"}`,
      JSON.stringify({
        type: "brief",
        lwc_text: "LWC",
        semantic_notes: [{ meaning: "m", check: "c", quoted_text: "q", trigger: { name: "Topic" } }],
        tnn_notes: ["note", 3],
        cultural_background: [{ term: "Joppa", summary: "A port." }, { term: "x" }],
      }),
    ].join("\n")
    const res = parseCopilotStream(body)
    expect(res).toEqual({
      ok: true,
      data: {
        available: true,
        lwcText: "LWC",
        notes: [{ topic: "Topic", meaning: "m", check: "c", quotedText: "q" }],
        translatorNotes: ["note"],
        culturalBackground: [{ term: "Joppa", summary: "A port." }],
      },
    })
  })

  it("treats an upstream error line as an unavailable verse, not a failure", () => {
    const res = parseCopilotStream(`{"type":"error","error":"Verse reference Foo 1:1 does not exist."}`)
    expect(res.ok && res.data.available).toBe(false)
  })

  it("fails when the stream ends without a brief (e.g. truncated)", () => {
    expect(parseCopilotStream(`{"type":"step"}\n{"type":"bri`).ok).toBe(false)
  })
})
