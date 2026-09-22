import { CONVERSATION_PARAM, TEAM_CHAT_CONVERSATION } from "./team-channel"

export type AgentWorkspaceView = "conversation" | "document" | "review" | "knowledge"

export function readAgentWorkspaceView(params: URLSearchParams): AgentWorkspaceView {
  const view = params.get("view")
  const conversation = params.get(CONVERSATION_PARAM) ?? TEAM_CHAT_CONVERSATION
  if (view === "document" && conversation !== TEAM_CHAT_CONVERSATION) return "conversation"
  return view === "document" || view === "review" || view === "knowledge" ? view : "conversation"
}

export function agentConversationHref(
  projectId: string,
  conversationId = TEAM_CHAT_CONVERSATION,
  view: AgentWorkspaceView = "conversation",
): string {
  const params = new URLSearchParams({ [CONVERSATION_PARAM]: conversationId })
  if (view !== "conversation" && (view !== "document" || conversationId === TEAM_CHAT_CONVERSATION)) params.set("view", view)
  return `/project/${encodeURIComponent(projectId)}/agent?${params}`
}
