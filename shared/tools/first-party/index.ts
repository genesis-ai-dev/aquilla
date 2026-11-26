/**
 * First-party Smart Extensions shipped with Aquilla.
 *
 * Installed into a project by the server (`POST /tools/first-party`) from
 * reviewed source in this repo — never client-supplied, never generated.
 * Aquilla's main translation editor is the native React editor; first-party
 * extensions focus on high-value integrations (such as the Door43 importer)
 * built on the same public extension API any extension uses.
 */

import type { ToolManifest } from "../manifest"
import { DOOR43_IMPORTER_MANIFEST, DOOR43_IMPORTER_SOURCE, FIRST_PARTY_DOOR43_IMPORTER } from "./door43-importer"

export interface FirstPartyTool {
  key: string
  manifest: ToolManifest
  source: string
}

export const FIRST_PARTY_TOOLS: Readonly<Record<string, FirstPartyTool>> = {
  // AQU-1937: the Door43 importer, on the public importer API.
  [FIRST_PARTY_DOOR43_IMPORTER]: {
    key: FIRST_PARTY_DOOR43_IMPORTER,
    manifest: DOOR43_IMPORTER_MANIFEST,
    source: DOOR43_IMPORTER_SOURCE,
  },
}

/** Deterministic, UUID-shaped tool id per (project, first-party key): makes
 *  the server's install idempotent (INSERT … ON CONFLICT (id)) without a
 *  schema change, and an archived ("removed") first-party tool stays removed. */
export async function firstPartyToolId(projectId: string, key: string): Promise<string> {
  const bytes = new TextEncoder().encode(`aquilla:first-party:${key}:${projectId}`)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  const hex = Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")
  // Version nibble 5 / RFC 4122 variant, like a name-based UUID.
  const v = `5${hex.slice(13, 16)}`
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${v}-${variant}-${hex.slice(20, 32)}`
}
