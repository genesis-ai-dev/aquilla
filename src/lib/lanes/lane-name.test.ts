import { describe, expect, it } from "vitest"
import { laneNameProblem } from "./lane-name"

const others = [
  { id: "a", name: "Yoruba" },
  { id: "b", name: "Yoruba Team" },
]

describe("laneNameProblem", () => {
  it("allows a distinct name and the lane keeping its own name", () => {
    expect(laneNameProblem({ laneId: "b", name: "Yoruba Village Talk", others })).toBeNull()
    expect(laneNameProblem({ laneId: "a", name: "Yoruba", others })).toBeNull()
  })

  it("rejects an empty name and a duplicate, including case differences", () => {
    expect(laneNameProblem({ laneId: "b", name: "   ", others })).toBe("empty")
    expect(laneNameProblem({ laneId: "b", name: "yoruba", others })).toBe("duplicate")
  })
})
