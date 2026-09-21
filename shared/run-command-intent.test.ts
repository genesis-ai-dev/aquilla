import { describe, it, expect } from "vitest"
import {
  classifyRunCommandIntent,
  INTENT_TO_RUN_COMMAND,
  MAX_COMMAND_WORDS,
} from "./run-command-intent"

describe("classifyRunCommandIntent — stop", () => {
  it.each([
    "stop",
    "Stop.",
    "STOP!",
    "please stop",
    "stop please",
    "halt",
    "stop working",
    "stop the run",
    "stop drafting now",
    "abort",
    "cancel the run",
    "  stop  ",
  ])("reads %j as a stop command", (message) => {
    expect(classifyRunCommandIntent(message)).toBe("stop")
  })

  it("ignores a leading persona mention", () => {
    expect(classifyRunCommandIntent("@Coordinator stop")).toBe("stop")
    expect(classifyRunCommandIntent("@coordinator, stop now")).toBe("stop")
    expect(classifyRunCommandIntent("@drafter @reviewer halt")).toBe("stop")
  })
})

describe("classifyRunCommandIntent — pause", () => {
  it.each([
    "pause",
    "Pause!",
    "please pause",
    "pause the run",
    "wait",
    "wait a second",
    "hold on",
    "hold up",
    "hang on",
    "@Coordinator pause",
  ])("reads %j as a pause command", (message) => {
    expect(classifyRunCommandIntent(message)).toBe("pause")
  })
})

describe("classifyRunCommandIntent — directions stay directions", () => {
  it.each([
    // The negative case from AQU-1299: a real instruction that contains "stop".
    "stop using contractions in narration",
    "stop using formal register in dialogue",
    "don't stop mid-sentence",
    "wait for the reviewer before staging anything",
    "hold the formal register in dialogue",
    "keep the tone formal in dialogue",
    "pause between clauses in the narration voice",
    "",
    "   ",
    "@Coordinator keep the tone formal",
  ])("reads %j as a direction", (message) => {
    expect(classifyRunCommandIntent(message)).toBe("direction")
  })

  it("treats anything longer than the command cap as a direction", () => {
    const longCommand = Array(MAX_COMMAND_WORDS + 1).fill("stop").join(" ")
    expect(classifyRunCommandIntent(longCommand)).toBe("direction")
  })

  it("prefers stop when a message carries both verbs", () => {
    expect(classifyRunCommandIntent("pause and stop")).toBe("stop")
  })
})

describe("INTENT_TO_RUN_COMMAND", () => {
  it("routes stop to terminate and pause to pause", () => {
    expect(INTENT_TO_RUN_COMMAND.stop).toBe("terminate")
    expect(INTENT_TO_RUN_COMMAND.pause).toBe("pause")
  })
})
