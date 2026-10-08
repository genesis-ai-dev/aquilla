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
}

/** The event kind whose server role floor bounds each write scope. */
const SCOPE_EVENT_KIND: Partial<Record<ToolScope, string>> = {
  "write:target": "target.cell.commit",
  "write:validation": "cell.validate",
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
