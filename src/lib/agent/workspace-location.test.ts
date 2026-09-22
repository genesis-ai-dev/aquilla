import { describe, expect, it } from "vitest"
import { agentConversationHref, readAgentWorkspaceView } from "./workspace-location"

describe("agent workspace location", () => {
  it("uses one conversation default, including legacy and unknown views", () => {
    for (const search of ["", "view=chat", "view=unknown", "conversation=run%3Aone"]) {
      expect(readAgentWorkspaceView(new URLSearchParams(search))).toBe("conversation")
    }
  })

  it("roundtrips review and document links without changing the conversation", () => {
    for (const view of ["review", "document", "knowledge"] as const) {
      const conversation = view === "document" ? "team-chat" : "run:one"
      const url = new URL(agentConversationHref("p/1", conversation, view), "https://local.test")
      expect(url.pathname).toBe("/project/p%2F1/agent")
      expect(url.searchParams.get("conversation")).toBe(conversation)
      expect(readAgentWorkspaceView(url.searchParams)).toBe(view)
    }
  })

  it("never shows the editor's unrelated document as a selected task's context", () => {
    expect(readAgentWorkspaceView(new URLSearchParams("conversation=run%3Aone&view=document"))).toBe("conversation")
    expect(agentConversationHref("p1", "run:one", "document")).toBe("/project/p1/agent?conversation=run%3Aone")
  })

  it("reselecting a conversation removes the competing view", () => {
    const href = agentConversationHref("p1", "run:one")
    expect(href).toBe("/project/p1/agent?conversation=run%3Aone")
    expect(readAgentWorkspaceView(new URL(href, "https://local.test").searchParams)).toBe("conversation")
  })
})
