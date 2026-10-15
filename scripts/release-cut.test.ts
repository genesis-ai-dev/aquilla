import { describe, expect, it } from "vitest"
import { releaseNotes } from "./release-cut.mjs"

const plan = {
  cut: true,
  hold: false,
  reason: "4 ready PR(s), no release in flight",
  branch: "release/2026/09/24-02",
  sha: "abc123",
  areas: ["sync"],
  prs: [
    { number: 771, walk: "PASS", areas: [] },
    { number: 772, walk: "PASS", areas: ["sync"] },
    { number: 773, walk: "fail", areas: [] },
    { number: 774, walk: "none", areas: [] },
  ],
}

describe("releaseNotes", () => {
  it("follows DEPLOY-BOT.md's template", () => {
    const titles = { 771: "Remove Inworld companion preset", 772: "Comment thread polish", 773: "Export raw mode fix", 774: "Retention tab copy" }
    expect(releaseNotes(plan, titles)).toBe([
      "## Release release/2026/09/24-02 · 4 PRs · areas: sync",
      "",
      "| PR | Title | Walk @ head sha | Areas |",
      "| --- | --- | --- | --- |",
      "| #771 | Remove Inworld companion preset | PASS | — |",
      "| #772 | Comment thread polish | PASS | sync |",
      "| #773 | Export raw mode fix | fail | — |",
      "| #774 | Retention tab copy | none (docs only) | — |",
      "",
      "Needs a human: #773 (walk fail).",
    ].join("\n"))
  })

  it("adds the held line, drops empty areas, and says none when nobody needs a look", () => {
    const held = { ...plan, hold: true, reason: "oldest unreleased PR holds", areas: [], prs: [{ number: 800, walk: "PASS", areas: ["migration"] }] }
    const notes = releaseNotes(held, { 800: "Add a column | safely" })
    expect(notes).toContain("## Release release/2026/09/24-02 · 1 PRs\n\n**Held:** oldest unreleased PR holds\n")
    expect(notes).toContain("| #800 | Add a column \\| safely | PASS | migration |")
    expect(notes).toMatch(/Needs a human: none$/)
  })

  it("prints a placeholder when a title could not be fetched", () => {
    expect(releaseNotes(plan, {})).toContain("| #771 | (title unavailable) | PASS | — |")
  })
})
