import { CONVERSATION_PARAM, TEAM_CHAT_CONVERSATION } from "./team-channel"

export type AgentWorkspaceView = "conversation" | "document" | "review" | "checks" | "knowledge"

export function readAgentWorkspaceView(params: URLSearchParams): AgentWorkspaceView {
  const view = params.get("view")
  const conversation = params.get(CONVERSATION_PARAM) ?? TEAM_CHAT_CONVERSATION
  if (view === "document" && conversation !== TEAM_CHAT_CONVERSATION) return "conversation"
  // Checks is a run's PR tab: it has no meaning on Team chat.
  if (view === "checks") return conversation === TEAM_CHAT_CONVERSATION ? "conversation" : "checks"
  return view === "document" || view === "review" || view === "knowledge" ? view : "conversation"
}

export function agentConversationHref(
  projectId: string,
  conversationId = TEAM_CHAT_CONVERSATION,
  view: AgentWorkspaceView = "conversation",
): string {
  const params = new URLSearchParams({ [CONVERSATION_PARAM]: conversationId })
  const teamOnly = view === "document"
  const runOnly = view === "checks"
  if (
    view !== "conversation" &&
    (!teamOnly || conversationId === TEAM_CHAT_CONVERSATION) &&
    (!runOnly || conversationId !== TEAM_CHAT_CONVERSATION)
  ) params.set("view", view)
  return `/project/${encodeURIComponent(projectId)}/agent?${params}`
}
