/**
 * Aquilla Tools — the manifest contract shared by the SPA host, the
 * auth-worker store/builder and the sync-worker provenance stamp.
 *
 * A tool is a single-file HTML+JS mini-app that runs inside a sandboxed
 * iframe and talks to the host only through the postMessage bridge
 * (src/lib/tools/runtime-source.ts). Its manifest declares which bridge
 * scopes it needs; the user approves them once as a standing grant.
 */

/** Bridge API revision. Bump when a bridge call is added, removed or changes
 *  shape; tools built against an older revision still run while it is at or
 *  above TOOLS_MIN_API_REV (api-rev.ts), and are flagged "rebuild" below it.
 *  Rev 2 (additive only): the surfaces the first-party default editor needs —
 *  rich text, paged/targeted reads, unvalidate, presence, comments, audio and
 *  host shortcuts. Rev 3 (additive only): what full editor parity needs —
 *  the host's editor config, chapter sections, per-cell signals, AI drafting,
 *  back-translation, key terms, live presence drafts, suggestions, host
 *  panels (history, attachments, rules, recorder) and the bulk selection.
 *  Rev 4 (additive only): `manifest.sdk` — the host injects the in-frame
 *  extension SDK (`window.aq`: live data hooks, Aquilla components, UI kit,
 *  actions) on top of the bridge. See API_REV_ADDITIONS in api-rev.ts. */
export const TOOLS_API_REV = 4

/** SDK majors the host can inject (manifest.sdk; shared/tools/sdk/sdk.ts). */
export const TOOLS_SDK_MAJORS: readonly number[] = [1]
/** First apiRev that knows manifest.sdk. */
export const TOOLS_SDK_MIN_API_REV = 4

/** Every scope a manifest may declare. Reads of project metadata (name, the
 *  current user, theme) need no scope. */
export const TOOL_SCOPES = [
  "read:cells",
  "read:terms",
  "write:target",
  "write:validation",
  "ai:generate",
  "read:comments",
  "ai:draft",
  "write:audio",
] as const

export type ToolScope = (typeof TOOL_SCOPES)[number]

export const TOOL_SCOPE_LABELS: Record<ToolScope, string> = {
  "read:cells": "read files and cells",
  "read:terms": "read the termbase",
  "write:target": "edit translations",
  "write:validation": "mark cells validated",
  "ai:generate": "use AI on your behalf",
  "read:comments": "see comment counts and open comment threads",
  "ai:draft": "draft and back-translate with Aquilla's AI (uses your project's AI credits)",
  "write:audio": "record and generate audio for cells",
}

export function isToolScope(value: unknown): value is ToolScope {
  return typeof value === "string" && (TOOL_SCOPES as readonly string[]).includes(value)
}

/** Where a tool can be mounted. `page` is always available; `panel` is the
 *  editor's left dock; `inline` is a tab under one cell (the tool gets that
 *  cell as `aquilla.context.cell`); `editor` replaces the standard editor for
 *  a file (the file arrives as `aquilla.context.file`). */
export type ToolMount = "page" | "panel" | "inline" | "editor"

export interface ToolManifest {
  name: string
  description: string
  scopes: ToolScope[]
  mounts: ToolMount[]
  apiRev: number
  /** apiRev 4: the extension SDK major to inject as `window.aq` (absent: none). */
  sdk?: number
}

export interface ManifestValidation {
  ok: boolean
  manifest: ToolManifest | null
  errors: string[]
}

const MAX_NAME = 80
const MAX_DESCRIPTION = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validate untrusted manifest JSON (model output or a client POST). Unknown
 *  scopes are an error, never silently dropped: a tool that asks for a scope
 *  that does not exist was built against an API we do not offer. */
export function validateManifest(input: unknown): ManifestValidation {
  const errors: string[] = []
  if (!isRecord(input)) return { ok: false, manifest: null, errors: ["manifest must be an object"] }

  const name = typeof input.name === "string" ? input.name.trim() : ""
  if (!name) errors.push("manifest.name is required")
  else if (name.length > MAX_NAME) errors.push(`manifest.name exceeds ${MAX_NAME} characters`)

  const description = typeof input.description === "string" ? input.description.trim() : ""
  if (description.length > MAX_DESCRIPTION) {
    errors.push(`manifest.description exceeds ${MAX_DESCRIPTION} characters`)
  }

  const rawScopes = Array.isArray(input.scopes) ? input.scopes : []
  const scopes: ToolScope[] = []
  for (const s of rawScopes) {
    if (isToolScope(s)) {
      if (!scopes.includes(s)) scopes.push(s)
    } else {
      errors.push(`unknown scope: ${String(s)}`)
    }
  }

  const rawMounts = Array.isArray(input.mounts) ? input.mounts : ["page"]
  const mounts: ToolMount[] = []
  for (const m of rawMounts) {
    if (m === "page" || m === "panel" || m === "inline" || m === "editor") {
      if (!mounts.includes(m)) mounts.push(m)
    } else {
      errors.push(`unknown mount: ${String(m)}`)
    }
  }
  if (!mounts.includes("page")) mounts.unshift("page")

  const apiRev = typeof input.apiRev === "number" && Number.isInteger(input.apiRev)
    ? input.apiRev
    : TOOLS_API_REV
  if (apiRev > TOOLS_API_REV) errors.push(`manifest.apiRev ${apiRev} is newer than this host (${TOOLS_API_REV})`)

  let sdk: number | undefined
  if (input.sdk !== undefined && input.sdk !== null) {
    if (typeof input.sdk === "number" && TOOLS_SDK_MAJORS.includes(input.sdk)) sdk = input.sdk
    else errors.push(`manifest.sdk ${String(input.sdk)} is not an SDK this host offers (${TOOLS_SDK_MAJORS.join(", ")})`)
    if (apiRev < TOOLS_SDK_MIN_API_REV) errors.push(`manifest.sdk needs apiRev ${TOOLS_SDK_MIN_API_REV} or later`)
  }

  if (errors.length > 0) return { ok: false, manifest: null, errors }
  return { ok: true, manifest: { name, description, scopes, mounts, apiRev, ...(sdk ? { sdk } : {}) }, errors }
}

/** The provenance a tool write carries in its event payload (`tool_origin`).
 *  The sync-worker re-verifies it against project_tool_versions and stamps the
 *  server-side `events.provenance` envelope. */
export interface ToolOrigin {
  origin: "tool"
  toolId: string
  version: number
  codeHash: string
}

export function isToolOrigin(value: unknown): value is ToolOrigin {
  if (!isRecord(value)) return false
  return (
    value.origin === "tool" &&
    typeof value.toolId === "string" &&
    value.toolId.length > 0 &&
    typeof value.version === "number" &&
    Number.isInteger(value.version) &&
    typeof value.codeHash === "string" &&
    /^[0-9a-f]{64}$/.test(value.codeHash)
  )
}

/** Code hash of a tool version: sha256 over the source and the canonical
 *  manifest, so a scope change is a different hash even with identical code. */
export async function toolCodeHash(source: string, manifest: ToolManifest): Promise<string> {
  const canonical = JSON.stringify({
    source,
    manifest: {
      name: manifest.name,
      description: manifest.description,
      scopes: [...manifest.scopes].sort(),
      mounts: [...manifest.mounts].sort(),
      apiRev: manifest.apiRev,
      // Only when set, so every pre-SDK tool keeps its hash.
      ...(manifest.sdk ? { sdk: manifest.sdk } : {}),
    },
  })
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}
