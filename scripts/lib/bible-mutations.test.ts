// AQU-1701: the planted errors of the Bible data evals, on World English
// Bible verses.
//
// WHY: a planted error that is only half planted (one negator left, a name
// still there) is a published verse with a "no" label, and every miss on it
// would be charged to the check. Each generator plants the whole error, or
// returns null so the case is left out.

import { describe, expect, it } from "vitest"
import { dropNegation, ENGLISH_YOU, nameToPronoun, plantForm, pronounToName, removeQuestion, swapNames } from "./bible-mutations"

describe("planted errors", () => {
  it("drops every negator, or plants nothing when one would survive", () => {
    expect(dropNegation("For Jews have no dealings with Samaritans.")).toBe("For Jews have dealings with Samaritans.")
    expect(dropNegation("You worship that which you don’t know.")).toBe("You worship that which you do know.")
    expect(dropNegation("Whoever drinks of the water that I will give him will never thirst again; he can’t.")).toBe(
      "Whoever drinks of the water that I will give him will thirst again; he can.",
    )
    expect(dropNegation("No, but he leads the multitude astray.")).toBeNull()
    expect(dropNegation("Jesus said to her, “Go.”")).toBeNull()
  })

  it("makes a question a statement, or nothing without one", () => {
    expect(removeQuestion("Are you greater than our father Jacob?")).toBe("Are you greater than our father Jacob.")
    expect(removeQuestion("Jesus answered her.")).toBeNull()
  })

  it("takes a name out for the pronoun its place needs", () => {
    expect(nameToPronoun("On the next day, he was determined to go out into Galilee, and he found Philip. Jesus said to him, “Follow me.”", "Philip", "m:one")).toBe(
      "On the next day, he was determined to go out into Galilee, and he found him. Jesus said to him, “Follow me.”",
    )
    expect(nameToPronoun("Philip found Nathanael, and said to him", "Philip", "m:one")).toBe("He found Nathanael, and said to him")
    expect(nameToPronoun("He brought him to Jesus.", "Andrew", "m:one")).toBeNull()
  })

  it("plants a look-alike's name where the pronoun stood, and swaps two names", () => {
    expect(pronounToName("He brought him to Jesus.", "m:one", "Peter")).toBe("Peter brought him to Jesus.")
    expect(pronounToName("Jesus said to her, “Go.”", "m:one", "Peter")).toBeNull()
    expect(swapNames("Peter turned and saw John following.", "Peter", "John")).toBe("John turned and saw Peter following.")
  })

  it("plants a profile's form for every English 'you'", () => {
    expect(plantForm("Go, call your husband, and come here, you.", ENGLISH_YOU, "yu")).toBe("Go, call yu husband, and come here, yu.")
  })
})
