import { describe, expect, it } from "vitest"
import { scriptMockResponse } from "./mock-openrouter"
import { expandSlashCommand } from "../src/lib/agent/slash-commands"

type MockResponse = ReturnType<typeof scriptMockResponse>

function message(response: MockResponse) {
  return response.choices[0].message
}

describe("scripted local agent", () => {
  it("answers a greeting without reading the working set", () => {
    const reply = message(scriptMockResponse([{ role: "user", content: "hello" }]))

    expect(reply.content).toContain("local Aquilla agent is ready")
    expect(reply.tool_calls).toBeUndefined()
  })

  it("does not reuse a prior turn's tool result for a new greeting", () => {
    const reply = message(scriptMockResponse([
      { role: "user", content: "/status" },
      { role: "assistant", content: "Looking.", tool_calls: [] },
      { role: "tool", content: "old working-set table" },
      { role: "assistant", content: "Here's the old state." },
      { role: "user", content: "hello" },
    ]))

    expect(reply.content).toContain("local Aquilla agent is ready")
    expect(reply.content).not.toContain("old working-set table")
  })

  it("still drives the read tool for an explicit status request", () => {
    const statusPrompt = expandSlashCommand("/status")!
    const first = message(scriptMockResponse([{ role: "user", content: statusPrompt }]))
    expect(first.tool_calls?.[0]?.function.name).toBe("read")

    const final = message(scriptMockResponse([
      { role: "user", content: statusPrompt },
      { role: "assistant", content: first.content, tool_calls: first.tool_calls },
      { role: "tool", content: "cell_id|status\nc1|validated" },
    ]))
    expect(final.content).toContain("Here's the current state")
    expect(final.content).toContain("c1|validated")
  })
})
