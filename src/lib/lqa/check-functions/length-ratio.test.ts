import { describe, it, expect } from "vitest"
import { runCheck } from "./length-ratio"

const SOURCE = "In the beginning God created the heavens and the earth."

describe("length-ratio", () => {
  it("flags a translation that dropped most of the source", () => {
    expect(runCheck(SOURCE, "Au commencement.")).not.toBeNull()
  })

  it("flags a translation that grew far past the source", () => {
    expect(runCheck(SOURCE, SOURCE + " " + SOURCE + " " + SOURCE)).not.toBeNull()
  })

  it("accepts the ordinary spread between languages", () => {
    expect(runCheck(SOURCE, "Au commencement, Dieu créa les cieux et la terre.")).toBeNull()
  })

  it("skips short sources, where a few characters swing the ratio", () => {
    expect(runCheck("Amen.", "Ainsi soit-il, amen, vraiment.")).toBeNull()
  })

  it("counts letters and digits only, so punctuation and spacing don't move the ratio", () => {
    expect(runCheck(SOURCE, "Au   commencement,,, Dieu — créa ... les cieux et la terre!!!")).toBeNull()
  })
})
