import { describe, it, expect } from "vitest"
import { createRun, type AgentRunUi } from "./run-state"
import { chatTranscript } from "./transcript"

function run(prompt: string, items: AgentRunUi["items"]): AgentRunUi {
  return { ...createRun(prompt, "WIRE-ONLY legend the user never saw"), items }
}

describe("chatTranscript", () => {
  it("copies what the user saw: their bubble text and the agent's prose, in order", () => {
    const text = chatTranscript([
      run("What does “In the beginning God…” mean?", [
        { kind: "text", id: "i0", text: "It opens the creation account." },
        { kind: "text", id: "i1", text: "Hebrew bereshit." },
      ]),
      run("Thanks", [{ kind: "text", id: "i0", text: "You're welcome." }]),
    ])
    expect(text).toBe(
      "You: What does “In the beginning God…” mean?\n\n" +
      "Agent: It opens the creation account.\n\nHebrew bereshit.\n\n" +
      "You: Thanks\n\n" +
      "Agent: You're welcome.",
    )
  })

  // The wire content carries the hidden context legend for the model; pasting
  // it would dump file/cell ids into the user's notes.
  it("never includes the model-only wire content", () => {
    expect(chatTranscript([run("hi", [])])).not.toContain("WIRE-ONLY")
  })

  it("skips a turn the agent has not answered yet", () => {
    expect(chatTranscript([run("still thinking?", [])])).toBe("You: still thinking?")
  })
})
