// AQU-1178 — the Agent API's intentional exclusions, in one place.
//
// Credential minting, project deletion, billing, and changeset approval are
// browser-only BY DESIGN: each one is a thing a human account holder must do
// themselves, so no `aqk_` token will ever reach them. Agents had no way to
// learn that — every probe was an ordinary `not_found`, which reads as "wrong
// path, try again" and invites more guessing.
//
// This module is the single source for that list. Both adapters publish it
// (REST `GET /api/v1/external` → `uiOnly`; MCP `get_capabilities` → `uiOnly`)
// and the external 404 handler consults it, so the docs, the discovery map and
// the error hints cannot drift apart.

/** One surface the Agent API deliberately does not expose. */
export interface UiOnlySurface {
  /** Stable id, quotable in an error hint. */
  id: string
  /** What an agent was probably trying to do. */
  what: string
  /** Why it is a human's job, in one line. */
  why: string
  /** Where a human actually does it. */
  humanPath: string
  /**
   * Lowercased words that signal a probe for this surface. Matched against
   * WHOLE `/`- or `_`-delimited segments of a URL path or an MCP tool name (see
   * `matchUiOnly`) — never a substring, so a project id like `token-store-x`
   * cannot masquerade as a credential probe.
   */
  probes: string[]
}

/**
 * The exclusions. Add a row here (never a second list elsewhere) whenever a
 * capability is decided to be permanently browser-only — a capability that is
 * merely *unbuilt* does not belong here, because this list promises "never",
 * not "not yet".
 */
export const UI_ONLY_SURFACES: UiOnlySurface[] = [
  {
    id: 'credential-minting',
    what: 'Minting, rotating, or revoking Aquilla API credentials (aqk_ tokens).',
    why:
      'A credential may only be created by a signed-in human: a token that can mint tokens ' +
      'makes revocation meaningless and lets an agent outlive its own grant.',
    humanPath:
      'Aquilla app → Preferences → Account → "API tokens" (identity host POST /api/v2/credentials, browser session JWT only — never an aqk_ token).',
    probes: ['credential', 'credentials', 'apikey', 'apikeys', 'api-key', 'api-keys', 'api-tokens'],
  },
  {
    id: 'project-deletion',
    what: 'Deleting or archiving a project, and bulk-deleting its files or members.',
    why:
      'Destruction is irreversible for everyone on the project and has no changeset to ' +
      'review, so a human owner confirms it in the browser instead.',
    humanPath: 'Aquilla app → Project Settings → Danger zone.',
    probes: ['archive', 'delete', 'destroy'],
  },
  {
    id: 'billing',
    what: 'Plans, credits, payment methods, invoices, and entitlement changes.',
    why:
      'Money movement is bound to the human account holder and the payment provider’s own ' +
      'authenticated flow.',
    humanPath: 'Aquilla app → Org Settings → Billing.',
    probes: [
      'billing',
      'credits',
      'entitlement',
      'entitlements',
      'invoice',
      'invoices',
      'subscription',
      'subscriptions',
      'checkout',
    ],
  },
  {
    id: 'changeset-approval',
    what: 'Approving your own staged changeset in ask mode.',
    why:
      'The approval gate only means something if a person other than the caller performs ' +
      'it; an API that could approve would be act mode wearing a costume.',
    humanPath:
      'The approvalUrl returned by prepare, opened by a human in an authenticated browser session. Your agent then calls commit / confirm_changeset again.',
    probes: ['approve', 'approval', 'approvals', 'changeset-approvals'],
  },
]

/** Human-readable framing shipped alongside the list in both adapters. */
export const UI_ONLY_NOTE =
  'These capabilities are intentionally absent from the Agent API and always will be — ' +
  'they are not roadmap gaps. Do not probe for endpoints here; ask a human to do the step ' +
  'in the Aquilla app instead.'

/** The published shape, identical on REST discovery and MCP get_capabilities. */
export function uiOnlySection(): {
  note: string
  exclusions: { id: string; what: string; why: string; humanPath: string }[]
} {
  return {
    note: UI_ONLY_NOTE,
    exclusions: UI_ONLY_SURFACES.map(({ id, what, why, humanPath }) => ({
      id,
      what,
      why,
      humanPath,
    })),
  }
}

/**
 * Which exclusion (if any) an unmatched request was probing for, so the miss
 * can say "never, and here is why" rather than "no such route/tool". Takes a
 * URL path or an MCP tool name; both are split on non-alphanumerics and matched
 * whole-segment, so `/projects/token-store-x/cells` cannot masquerade as a
 * credential probe.
 */
export function matchUiOnly(pathOrToolName: string): UiOnlySurface | null {
  // `/` splits a path, `_` splits an MCP tool name (mint_credential). Hyphens
  // stay INSIDE a segment: `api-keys` is a probe, `token-store-x` is a project
  // id that happens to start with a suggestive word.
  const segments = new Set(pathOrToolName.toLowerCase().split(/[/_]+/).filter(Boolean))
  return UI_ONLY_SURFACES.find((s) => s.probes.some((p) => segments.has(p))) ?? null
}

/**
 * The 404/unknown-tool hint for a matched exclusion: what it is, why it is a
 * human's job, where the human does it, and where to read the whole list.
 */
export function uiOnlyHint(surface: UiOnlySurface, apiMapPath: string): string {
  return (
    `${surface.what} is intentionally UI-only — no Agent API endpoint or tool for it will ` +
    `ever exist. ${surface.why} Do it here instead: ${surface.humanPath} ` +
    `The full list of intentional exclusions is the uiOnly section of the API map ` +
    `(GET ${apiMapPath}) and of get_capabilities.`
  )
}
