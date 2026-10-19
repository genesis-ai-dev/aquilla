/**
 * Aquilla Tools — the manifest contract shared by the SPA host, the
 * auth-worker store/builder and the sync-worker provenance stamp.
 *
 * A tool is a single-file HTML+JS mini-app that runs inside a sandboxed
 * iframe and talks to the host only through the postMessage bridge
 * (src/lib/tools/runtime-source.ts). Its manifest declares which bridge
 * scopes it needs; the user approves them once as a standing grant.
 */

import { MAX_WEB_DOMAINS, validateWebDomain } from "./web-domains"

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
 *  actions) on top of the bridge. Rev 5 (additive only): what dev's built-in
 *  editor gained after rev 4 — Align styles, the AI-draft provenance wash,
 *  integrity-check explanations and the read-only/archived-lane banner. Rev 6
 *  (additive only): `read:web` + `manifest.web` and aquilla.web.fetch — reads
 *  from declared sites through the host's proxy. See API_REV_ADDITIONS in
 *  api-rev.ts. Rev 7 (additive only): extensions as importers and exporters —
 *  `write:files` + files.upsert / files.setMeta / files.source, extension data
 *  files (aquilla.data.*), cells.byRef across files, file groups, manifest
 *  `actions` (headless runs from the bar/menu/settings, optional check on
 *  project open) and manifest `exports` (formats in the export dialog), plus
 *  web.fetch as bytes. */
export const TOOLS_API_REV = 7

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
  "write:source",
  // apiRev 6: read from the sites in manifest.web, through the host's proxy.
  "read:web",
  // apiRev 7: create and refresh project files (importers). Project lead.
  "write:files",
  // apiRev 7: save records in the extension's hidden data files. Contributor.
  "write:data",
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
  "write:source": "edit source text and add, remove or hide cells",
  "read:web": "read from the websites it names",
  "write:files": "create and update project files",
  "write:data": "save its own data (alignments, notes, …) in hidden data files",
}

export function isToolScope(value: unknown): value is ToolScope {
  return typeof value === "string" && (TOOL_SCOPES as readonly string[]).includes(value)
}

/** Where a tool can be mounted. `page` is always available; `panel` is the
 *  editor's left dock; `inline` is a tab under one cell (the tool gets that
 *  cell as `aquilla.context.cell`); `editor` replaces the standard editor for
 *  a file (the file arrives as `aquilla.context.file`). */
export type ToolMount = "page" | "panel" | "inline" | "editor"

/** apiRev 7: a button that runs the extension HEADLESS (no visible frame).
 *  `where`: the extensions bar above the file view, the extensions palette
 *  menu, or the extension's card in Smart Extensions settings. `onOpen`: also
 *  run it (at most once a day per user) when a member who may write files opens
 *  the project — "check for updates" for live-linked importers. */
export interface ToolAction {
  id: string
  label: string
  where: ToolActionPlace[]
  onOpen?: boolean
}
export type ToolActionPlace = "bar" | "menu" | "settings"

/** apiRev 7: an export format the extension contributes to the export dialog.
 *  `tags`: offered only for files carrying one of these tags (absent = every
 *  file). The extension runs headless and hands files back with
 *  aquilla.export.deliver. */
export interface ToolExport {
  id: string
  label: string
  /** File extension of what it produces, e.g. "usfm", "tsv", "zip". */
  extension: string
  tags?: string[]
}

export interface ToolManifest {
  name: string
  description: string
  scopes: ToolScope[]
  mounts: ToolMount[]
  apiRev: number
  /** apiRev 4: the extension SDK major to inject as `window.aq` (absent: none). */
  sdk?: number
  /** apiRev 6: the sites `read:web` may read ("git.door43.org", "*.door43.org"). */
  web?: string[]
  /** apiRev 7: headless actions (import, check for updates, …). */
  actions?: ToolAction[]
  /** apiRev 7: export formats offered in the export dialog. */
  exports?: ToolExport[]
  /** apiRev 7 (AQU-1937): import contributions offered in the Import dialog. */
  importers?: ToolImporter[]
}

/** One field of an importer's options form. The PLATFORM renders the form
 *  from this schema (the extension never draws it); `dynamic` choices are
 *  asked of the extension headlessly (context.import.phase "choices"). */
export interface ToolImporterOption {
  key: string
  label: string
  type: "text" | "number" | "boolean" | "select" | "multiselect"
  required?: boolean
  default?: string | number | boolean | string[]
  help?: string
  choices?: { value: string; label: string }[]
  /** Choices come from the extension at run time (e.g. a catalog), and are
   *  re-asked when one of `dependsOn` changes. */
  dynamic?: boolean
  dependsOn?: string[]
}

/** apiRev 7 (AQU-1937): an import contribution. Runs headless
 *  (aquilla.context.mount "import"), writes through files.upsert, and the
 *  platform records { tool, importer, options, upstream } on every file it
 *  writes — so "Refresh from source" on a file re-runs it with those options. */
export interface ToolImporter {
  id: string
  label: string
  description?: string
  options: ToolImporterOption[]
}

const OPTION_TYPES = ["text", "number", "boolean", "select", "multiselect"] as const
const MAX_IMPORTERS = 4
const MAX_OPTIONS = 16

function readImporters(input: unknown, errors: string[]): ToolImporter[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) {
    errors.push("manifest.importers must be a list")
    return []
  }
  const out: ToolImporter[] = []
  for (const [i, raw] of input.entries()) {
    if (!isRecord(raw)) {
      errors.push(`manifest.importers[${i}] must be an object`)
      continue
    }
    const id = typeof raw.id === "string" ? raw.id : ""
    const label = typeof raw.label === "string" ? raw.label.trim() : ""
    if (!ACTION_ID.test(id)) errors.push(`manifest.importers[${i}].id must be lowercase letters, digits and dashes`)
    else if (out.some((x) => x.id === id)) errors.push(`manifest.importers has two importers with id ${id}`)
    if (!label || label.length > MAX_LABEL) errors.push(`manifest.importers[${i}].label must be 1-${MAX_LABEL} characters`)
    const description = typeof raw.description === "string" ? raw.description.trim().slice(0, MAX_DESCRIPTION) : ""
    const rawOptions = Array.isArray(raw.options) ? raw.options : []
    if (rawOptions.length > MAX_OPTIONS) errors.push(`manifest.importers[${i}] has more than ${MAX_OPTIONS} options`)
    const options: ToolImporterOption[] = []
    for (const [j, o] of rawOptions.entries()) {
      const where = `manifest.importers[${i}].options[${j}]`
      if (!isRecord(o)) {
        errors.push(`${where} must be an object`)
        continue
      }
      const key = typeof o.key === "string" ? o.key : ""
      const olabel = typeof o.label === "string" ? o.label.trim() : ""
      const type = OPTION_TYPES.find((t) => t === o.type)
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) errors.push(`${where}.key must be a short identifier`)
      else if (options.some((x) => x.key === key)) errors.push(`${where}.key ${key} is used twice`)
      if (!olabel || olabel.length > MAX_LABEL) errors.push(`${where}.label must be 1-${MAX_LABEL} characters`)
      if (!type) errors.push(`${where}.type must be one of ${OPTION_TYPES.join(", ")}`)
      const choices = Array.isArray(o.choices)
        ? o.choices.flatMap((c) => (isRecord(c) && typeof c.value === "string" ? [{ value: c.value, label: typeof c.label === "string" ? c.label : c.value }] : [])).slice(0, 500)
        : undefined
      const dynamic = o.dynamic === true
      if ((type === "select" || type === "multiselect") && !dynamic && (!choices || choices.length === 0)) {
        errors.push(`${where} needs choices (or dynamic: true)`)
      }
      const def = o.default
      const okDefault = def === undefined || typeof def === "string" || typeof def === "number" || typeof def === "boolean" || (Array.isArray(def) && def.every((d) => typeof d === "string"))
      if (!okDefault) errors.push(`${where}.default must be a string, number, boolean or list of strings`)
      const dependsOn = Array.isArray(o.dependsOn) ? o.dependsOn.filter((d): d is string => typeof d === "string").slice(0, 8) : undefined
      options.push({
        key,
        label: olabel,
        type: type ?? "text",
        ...(o.required === true ? { required: true } : {}),
        ...(def !== undefined && okDefault ? { default: def as ToolImporterOption["default"] } : {}),
        ...(typeof o.help === "string" ? { help: o.help.slice(0, 300) } : {}),
        ...(choices && choices.length ? { choices } : {}),
        ...(dynamic ? { dynamic: true } : {}),
        ...(dependsOn && dependsOn.length ? { dependsOn } : {}),
      })
    }
    out.push({ id, label, ...(description ? { description } : {}), options })
  }
  if (out.length > MAX_IMPORTERS) errors.push(`manifest.importers lists more than ${MAX_IMPORTERS} importers`)
  return out
}

const ACTION_ID = /^[a-z][a-z0-9-]{0,39}$/
const MAX_ACTIONS = 8
const MAX_EXPORTS = 8
const MAX_LABEL = 60
const ACTION_PLACES: readonly ToolActionPlace[] = ["bar", "menu", "settings"]

function readActions(input: unknown, errors: string[]): ToolAction[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) {
    errors.push("manifest.actions must be a list")
    return []
  }
  const out: ToolAction[] = []
  for (const [i, raw] of input.entries()) {
    if (!isRecord(raw)) {
      errors.push(`manifest.actions[${i}] must be an object`)
      continue
    }
    const id = typeof raw.id === "string" ? raw.id : ""
    const label = typeof raw.label === "string" ? raw.label.trim() : ""
    if (!ACTION_ID.test(id)) errors.push(`manifest.actions[${i}].id must be lowercase letters, digits and dashes`)
    else if (out.some((a) => a.id === id)) errors.push(`manifest.actions has two actions with id ${id}`)
    if (!label || label.length > MAX_LABEL) errors.push(`manifest.actions[${i}].label must be 1-${MAX_LABEL} characters`)
    const places = Array.isArray(raw.where) ? raw.where : ["bar"]
    const where: ToolActionPlace[] = []
    for (const p of places) {
      const place = ACTION_PLACES.find((x) => x === p)
      if (!place) errors.push(`manifest.actions[${i}].where: unknown place ${String(p)} (bar, menu, settings)`)
      else if (!where.includes(place)) where.push(place)
    }
    out.push({ id, label, where: where.length ? where : ["bar"], ...(raw.onOpen === true ? { onOpen: true } : {}) })
  }
  if (out.length > MAX_ACTIONS) errors.push(`manifest.actions lists more than ${MAX_ACTIONS} actions`)
  return out
}

function readExports(input: unknown, errors: string[]): ToolExport[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) {
    errors.push("manifest.exports must be a list")
    return []
  }
  const out: ToolExport[] = []
  for (const [i, raw] of input.entries()) {
    if (!isRecord(raw)) {
      errors.push(`manifest.exports[${i}] must be an object`)
      continue
    }
    const id = typeof raw.id === "string" ? raw.id : ""
    const label = typeof raw.label === "string" ? raw.label.trim() : ""
    const extension = typeof raw.extension === "string" ? raw.extension.replace(/^\./, "").toLowerCase() : ""
    if (!ACTION_ID.test(id)) errors.push(`manifest.exports[${i}].id must be lowercase letters, digits and dashes`)
    else if (out.some((x) => x.id === id)) errors.push(`manifest.exports has two formats with id ${id}`)
    if (!label || label.length > MAX_LABEL) errors.push(`manifest.exports[${i}].label must be 1-${MAX_LABEL} characters`)
    if (!/^[a-z0-9]{1,10}$/.test(extension)) errors.push(`manifest.exports[${i}].extension must be a file extension such as "usfm"`)
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string" && t.length > 0 && t.length <= 80).slice(0, 20) : []
    out.push({ id, label, extension, ...(tags.length ? { tags } : {}) })
  }
  if (out.length > MAX_EXPORTS) errors.push(`manifest.exports lists more than ${MAX_EXPORTS} formats`)
  return out
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

  const web: string[] = []
  if (input.web !== undefined && input.web !== null) {
    if (!Array.isArray(input.web)) errors.push("manifest.web must be a list of domains")
    else {
      for (const d of input.web) {
        const v = validateWebDomain(d)
        if (!v.ok) errors.push(v.error)
        else if (!web.includes(v.domain)) web.push(v.domain)
      }
      if (web.length > MAX_WEB_DOMAINS) errors.push(`manifest.web lists more than ${MAX_WEB_DOMAINS} domains`)
    }
  }
  if (scopes.includes("read:web") && web.length === 0) errors.push('scope read:web needs manifest.web: the domains it reads, e.g. ["git.door43.org"]')
  if (web.length > 0 && !scopes.includes("read:web")) errors.push("manifest.web is only allowed with the read:web scope")
  if (scopes.includes("read:web") && apiRev < 6) errors.push("scope read:web needs apiRev 6 or later")
  if (scopes.includes("write:files") && apiRev < 7) errors.push("scope write:files needs apiRev 7 or later")
  if (scopes.includes("write:data") && apiRev < 7) errors.push("scope write:data needs apiRev 7 or later")

  const actions = readActions(input.actions, errors)
  const exportsList = readExports(input.exports, errors)
  const importers = readImporters(input.importers, errors)
  if ((actions.length > 0 || exportsList.length > 0 || importers.length > 0) && apiRev < 7) errors.push("manifest.actions, manifest.exports and manifest.importers need apiRev 7 or later")
  if (importers.length > 0 && !scopes.includes("write:files")) errors.push("manifest.importers needs the write:files scope")

  if (errors.length > 0) return { ok: false, manifest: null, errors }
  return {
    ok: true,
    manifest: {
      name,
      description,
      scopes,
      mounts,
      apiRev,
      ...(sdk ? { sdk } : {}),
      ...(web.length ? { web } : {}),
      ...(actions.length ? { actions } : {}),
      ...(exportsList.length ? { exports: exportsList } : {}),
      ...(importers.length ? { importers } : {}),
    },
    errors,
  }
}

/** The provenance a tool write carries in its event payload (`tool_origin`).
 *  The sync-worker re-verifies it against project_tool_versions and stamps the
 *  server-side `events.provenance` envelope. */
export interface ToolOrigin {
  origin: "tool"
  toolId: string
  version: number
  codeHash: string
  /** apiRev 7: the server-minted tool session token (auth-worker
   *  POST /tools/:id/session). The sync-worker verifies its signature and that
   *  it names this tool, version, hash, project and author before it trusts the
   *  claim — and REQUIRES it for writes to files and extension data files. */
  session?: string
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
      ...(manifest.web?.length ? { web: [...manifest.web].sort() } : {}),
      ...(manifest.actions?.length ? { actions: manifest.actions } : {}),
      ...(manifest.exports?.length ? { exports: manifest.exports } : {}),
      ...(manifest.importers?.length ? { importers: manifest.importers } : {}),
    },
  })
  const bytes = new TextEncoder().encode(canonical)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
}
