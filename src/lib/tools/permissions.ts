/**
 * Tool permission model.
 *
 * - The manifest DECLARES scopes. At install the user approves them once; that
 *   approval is the STANDING GRANT (stored per project, tool and user).
 * - A bridge call needing a scope outside the standing grant pauses on an
 *   inline prompt: Allow once / Always / Deny. "Always" extends the standing
 *   grant; "once" covers that single call; "Deny" is remembered for the
 *   session so a tool cannot nag.
 * - The ROLE CEILING is checked first: a grant never exceeds what the user's
 *   own role may do (the client mirror of the server's role policy). The
 *   server's authorize() still re-checks every event regardless.
 */

import { canPerform } from "@/lib/sync/role-policy"
import { isToolScope, type ToolScope } from "../../../shared/tools/manifest"

/** Which scope each bridge method needs. Methods absent here need none. */
export const METHOD_SCOPES: Readonly<Record<string, ToolScope>> = {
  "files.list": "read:cells",
  "cells.list": "read:cells",
  "terms.list": "read:terms",
  "cells.commit": "write:target",
  "cells.validate": "write:validation",
  "ai.generate": "ai:generate",
  // apiRev 2
  "cells.page": "read:cells",
  "cells.get": "read:cells",
  "cells.unvalidate": "write:validation",
  "presence.list": "read:cells",
  // A focus lease is the first half of an edit: it needs the edit scope.
  "presence.claim": "write:target",
  "presence.release": "write:target",
  "comments.counts": "read:comments",
  "comments.open": "read:comments",
  "audio.list": "read:cells",
  "audio.play": "read:cells",
  // apiRev 3 (editor parity)
  "editor.config": "read:cells",
  "editor.setLane": "read:cells",
  "editor.setLens": "read:cells",
  "editor.openSettings": "read:cells",
  "cells.sections": "read:cells",
  "cells.signals": "read:cells",
  "cells.pericopes": "read:cells",
  // Settling a cell pays repetition propagation: more target writes.
  "cells.settle": "write:target",
  "terms.matches": "read:terms",
  "terms.open": "read:terms",
  "ai.draft": "ai:draft",
  "ai.draftParagraph": "ai:draft",
  "backtranslation.list": "read:cells",
  "backtranslation.run": "ai:draft",
  "backtranslation.save": "write:target",
  "history.open": "read:cells",
  "attachments.open": "read:cells",
  "rules.open": "read:cells",
  "presence.peers": "read:cells",
  // Your live draft is shown to collaborators: the first half of an edit.
  "presence.typing": "write:target",
  "presence.view": "read:cells",
  "editor.visible": "read:cells",
  "audio.record": "write:audio",
  "audio.generate": "write:audio",
  "selection.set": "read:cells",
  "suggestions.get": "read:cells",
  "suggestions.feedback": "read:cells",
  // apiRev 4
  "audio.takes": "read:cells",
  "audio.validate": "write:validation",
  "audio.unvalidate": "write:validation",
  "audio.take": "read:cells",
  "audio.trim": "write:audio",
  "audio.voices": "read:cells",
  "audio.assignVoice": "write:audio",
  "audio.clone": "write:audio",
  "source.actions": "read:cells",
  "source.commit": "write:source",
  "source.setHidden": "write:source",
  "source.insert": "write:source",
  "source.remove": "write:source",
  "source.retime": "write:source",
  "ai.examples": "read:cells",
  "ai.contextual": "read:cells",
  "ai.reviewContextual": "write:target",
  "ai.smartEdits": "read:cells",
  "ai.smartEditFeedback": "read:cells",
  "terms.selection": "read:terms",
  "terms.view": "read:terms",
  "terms.add": "read:terms",
  "agent.ask": "read:cells",
}

/** The event kind whose server role floor bounds each write scope. */
const SCOPE_EVENT_KIND: Partial<Record<ToolScope, string>> = {
  "write:target": "target.cell.commit",
  "write:validation": "cell.validate",
  // An AI draft lands as a target commit; generated/recorded audio as an attach.
  "ai:draft": "target.cell.commit",
  "write:audio": "cell.audio.attach",
}

/** Whether a user at `roleLevel` could perform this scope themselves. Reads
 *  are open to every member; writes follow the event-kind role floor. */
export function roleAllowsScope(scope: ToolScope, roleLevel: number | null): boolean {
  const kind = SCOPE_EVENT_KIND[scope]
  if (!kind) return true
  return canPerform(kind, roleLevel)
}

export type ScopeDecision =
  | { kind: "allow" }
  | { kind: "prompt" }
  | { kind: "deny"; reason: "role" | "denied" | "unknown-scope" }

export interface PermissionState {
  /** The standing grant (persisted server-side). */
  standing: ReadonlySet<ToolScope>
  /** Scopes the user denied this session. */
  deniedThisSession: ReadonlySet<ToolScope>
  roleLevel: number | null
}

/** Decide what happens when a tool calls something needing `scope`. */
export function decideScope(scope: string, state: PermissionState): ScopeDecision {
  if (!isToolScope(scope)) return { kind: "deny", reason: "unknown-scope" }
  if (!roleAllowsScope(scope, state.roleLevel)) return { kind: "deny", reason: "role" }
  if (state.standing.has(scope)) return { kind: "allow" }
  if (state.deniedThisSession.has(scope)) return { kind: "deny", reason: "denied" }
  return { kind: "prompt" }
}

export type PromptAnswer = "once" | "always" | "deny"

export interface PromptOutcome {
  allowed: boolean
  /** The new standing grant when "always" extended it, else null (unchanged). */
  nextStanding: ToolScope[] | null
  /** Scope to remember as denied for the session, else null. */
  deny: ToolScope | null
}

/** Fold an inline-prompt answer into the permission state. */
export function applyPromptAnswer(
  scope: ToolScope,
  answer: PromptAnswer,
  standing: ReadonlySet<ToolScope>,
): PromptOutcome {
  if (answer === "deny") return { allowed: false, nextStanding: null, deny: scope }
  if (answer === "once") return { allowed: true, nextStanding: null, deny: null }
  const next = new Set(standing)
  next.add(scope)
  return { allowed: true, nextStanding: [...next], deny: null }
}

/** At install: the scopes the user can actually grant (declared ∩ role). The
 *  rest are listed as "not available at your role" in the install dialog. */
export function grantableAtInstall(
  declared: readonly ToolScope[],
  roleLevel: number | null,
): { grantable: ToolScope[]; blocked: ToolScope[] } {
  const grantable: ToolScope[] = []
  const blocked: ToolScope[] = []
  for (const s of declared) (roleAllowsScope(s, roleLevel) ? grantable : blocked).push(s)
  return { grantable, blocked }
}

/** Remove one scope from a standing grant (the Tools page revoke control). */
export function revokeScope(standing: readonly ToolScope[], scope: ToolScope): ToolScope[] {
  return standing.filter((s) => s !== scope)
}
