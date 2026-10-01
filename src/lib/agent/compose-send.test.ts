import { describe, expect, it } from "vitest"
import { composeAgentSend } from "./compose-send"

describe("composeAgentSend run context", () => {
  // AQU-1447: the agent's draft/read/search tools scope to the active lane. A
  // lane-only context (no file or cell focused) must still reach the server,
  // or a multi-lane project silently drafts into the wrong language.
  it("sends a lane-only context", () => {
    const out = composeAgentSend({ text: "draft this", jwt: "t", projectId: "p", context: { lane: "fr" } })
    expect(out?.request.context).toEqual({ lane: "fr" })
  })

  it("omits context when nothing is focused", () => {
    const out = composeAgentSend({ text: "hi", jwt: "t", projectId: "p", context: {} })
    expect(out?.request).not.toHaveProperty("context")
  })
})
