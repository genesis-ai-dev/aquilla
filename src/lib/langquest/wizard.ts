// The New-project wizard's state (AQU-2105 follow-up): one choice per step.
//
//   source ─┬─ scratch  → the ordinary create form, self-contained shape
//           ├─ linked   → the ordinary create form, linked-target shape
//           └─ langquest → org → (connect) → language → details
//
// Pure: the dialog and the LangQuest panel render whatever `step` says and
// dispatch these transitions; the tests pin the walk through them. The org
// step is skipped when the user has no saved connection yet — there is
// nothing to pick, so the first thing to do is connect.

import type { LangQuestConnection } from "./types"

export type ProjectSource = "scratch" | "linked" | "langquest"

export type WizardStep =
  | { kind: "source" }
  | { kind: "form"; source: Exclude<ProjectSource, "langquest"> }
  /** LangQuest picked before the saved connections are known: a spinner, then org or connect. */
  | { kind: "loading" }
  | { kind: "org" }
  | { kind: "connect" }
  | { kind: "language"; connectionId: string }
  | { kind: "details"; connectionId: string; languageId: string }

export interface WizardState {
  step: WizardStep
  /** Connections known to the wizard; refreshed whenever one is made. */
  connections: LangQuestConnection[]
  /** False until the saved connections have been fetched once (or the fetch failed). */
  connectionsKnown: boolean
}

export const INITIAL_WIZARD_STATE: WizardState = { step: { kind: "source" }, connections: [], connectionsKnown: false }

export type WizardAction =
  | { type: "pickSource"; source: ProjectSource }
  | { type: "connectionsLoaded"; connections: LangQuestConnection[] }
  | { type: "startConnect" }
  | { type: "connected"; connection: LangQuestConnection }
  | { type: "pickConnection"; connectionId: string }
  | { type: "pickLanguage"; languageId: string }
  | { type: "back" }
  | { type: "reset" }
  /** The dialog closed: fetch the connections afresh next time (one made in Preferences meanwhile). */
  | { type: "forgetConnections" }

/** A connection whose token LangQuest still honours, as far as we know. */
export function isUsable(connection: Pick<LangQuestConnection, "health">): boolean {
  return connection.health === "ok" || connection.health === "unreachable"
}

/** Where the LangQuest branch starts: pick an org if there is one to pick, else connect. */
export function langquestEntryStep(connections: LangQuestConnection[]): WizardStep {
  return connections.length > 0 ? { kind: "org" } : { kind: "connect" }
}

function upsert(connections: LangQuestConnection[], connection: LangQuestConnection): LangQuestConnection[] {
  const i = connections.findIndex((c) => c.id === connection.id)
  if (i < 0) return [...connections, connection]
  return connections.map((c, j) => (j === i ? connection : c))
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  const { step, connections } = state
  switch (action.type) {
    case "reset":
      return { ...INITIAL_WIZARD_STATE, connections, connectionsKnown: state.connectionsKnown }
    case "forgetConnections":
      return { ...state, connectionsKnown: false }
    case "connectionsLoaded": {
      // Arriving while the user waits on, or is at, the org/connect fork
      // re-decides the fork; anywhere else the list just updates.
      const next = { ...state, connections: action.connections, connectionsKnown: true }
      if (step.kind === "loading" || step.kind === "org" || step.kind === "connect") {
        return { ...next, step: langquestEntryStep(action.connections) }
      }
      return next
    }
    case "pickSource":
      if (step.kind !== "source") return state
      if (action.source === "langquest") {
        return { ...state, step: state.connectionsKnown ? langquestEntryStep(connections) : { kind: "loading" } }
      }
      return { ...state, step: { kind: "form", source: action.source } }
    case "startConnect":
      if (step.kind !== "org") return state
      return { ...state, step: { kind: "connect" } }
    case "connected": {
      // A fresh token goes straight on to its languages, whichever step asked for it.
      const next = upsert(connections, action.connection)
      return { ...state, connections: next, step: { kind: "language", connectionId: action.connection.id } }
    }
    case "pickConnection": {
      if (step.kind !== "org") return state
      const chosen = connections.find((c) => c.id === action.connectionId)
      if (!chosen || !isUsable(chosen)) return state
      return { ...state, step: { kind: "language", connectionId: chosen.id } }
    }
    case "pickLanguage":
      if (step.kind !== "language") return state
      return { ...state, step: { kind: "details", connectionId: step.connectionId, languageId: action.languageId } }
    case "back":
      switch (step.kind) {
        case "source":
          return state
        case "form":
        case "loading":
        case "org":
          return { ...state, step: { kind: "source" } }
        case "connect":
          // Back from pasting a token: to the org list when there is one, else to the start.
          return { ...state, step: connections.length > 0 ? { kind: "org" } : { kind: "source" } }
        case "language":
          return { ...state, step: langquestEntryStep(connections) }
        case "details":
          return { ...state, step: { kind: "language", connectionId: step.connectionId } }
      }
  }
}

/** Where tokens are made. The preview API base points at the preview app. */
export const DEFAULT_LANGQUEST_CONNECT_URL = "https://next.langquest.org/connect"

export function langquestConnectUrl(apiBase: string | undefined | null): string {
  try {
    if (apiBase) return `${new URL(apiBase).origin}/connect`
  } catch {
    // fall through to production
  }
  return DEFAULT_LANGQUEST_CONNECT_URL
}

/** The connect URL the wizard opens: the one the user's connections already use, else production. */
export function connectUrlFor(connections: Pick<LangQuestConnection, "apiBase">[]): string {
  return langquestConnectUrl(connections[0]?.apiBase)
}
