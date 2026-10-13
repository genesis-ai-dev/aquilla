import { describe, expect, it } from "vitest"
import { groupByFile, type ExpertEventRow } from "../lib/react-signals"

const row = (over: Partial<ExpertEventRow>): ExpertEventRow => ({
  id: `e-${Math.random()}`,
  kind: "target.cell.commit",
  file_id: "f1",
  target_lang: "",
  lane_id: "lane-def",
  cell_id: "c1",
  canonical_ref: null,
  server_ts: 1,
  ...over,
})

describe("react signals are lane-scoped", () => {
  // A reaction drafts in the lane it reacts to. If edits in a second language
  // collapsed into the default lane's signal, a French reviewer's corrections
  // would kick off drafting in English.
  it("keeps edits in two lanes of one file as separate signals", () => {
    const signals = groupByFile([
      row({ target_lang: "", lane_id: "lane-def", cell_id: "a", server_ts: 1 }),
      row({ target_lang: "fr", lane_id: "lane-fr", cell_id: "b", server_ts: 2 }),
      row({ target_lang: "fr", lane_id: "lane-fr", cell_id: "c", server_ts: 3 }),
    ])
    expect(signals.map((s) => [s.laneId, s.count, s.anchorCellId])).toEqual([
      ["lane-fr", 2, "c"],
      ["lane-def", 1, "a"],
    ])
  })

  // AQU-1610: the tag is not an identity. Two lanes agree on it whenever one
  // was retagged after its rows were written — and grouping on the tag then
  // merged their edits, so a reaction to one lane's correction drafted into
  // whichever lane the merged signal happened to carry.
  it("separates two lanes that share a tag", () => {
    const signals = groupByFile([
      row({ target_lang: "es", lane_id: "lane-a", cell_id: "a", server_ts: 1 }),
      row({ target_lang: "es", lane_id: "lane-b", cell_id: "b", server_ts: 2 }),
    ])
    expect(signals.map((s) => [s.laneId, s.count])).toEqual([
      ["lane-b", 1],
      ["lane-a", 1],
    ])
  })

  // A tag that resolves to no lane is its own bucket, never folded into a
  // real lane's signal.
  it("keeps an unresolvable lane apart from every real one", () => {
    const signals = groupByFile([
      row({ target_lang: "gone", lane_id: null, cell_id: "a", server_ts: 1 }),
      row({ target_lang: "", lane_id: "lane-def", cell_id: "b", server_ts: 2 }),
    ])
    expect(signals.map((s) => s.laneId)).toEqual(["lane-def", null])
  })

  // Jev reads the newest few commits as its before → after sample; a
  // validation carries no text change, so it never becomes a sample.
  it("keeps the newest text commits, capped, and leaves validations out", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((n) => row({ id: `c${n}`, server_ts: n }))
    rows.push(row({ id: "v1", kind: "cell.validate", server_ts: 7 }))
    const [signal] = groupByFile(rows)
    expect(signal.commitEventIds).toEqual(["c2", "c3", "c4", "c5", "c6"])
  })
})
