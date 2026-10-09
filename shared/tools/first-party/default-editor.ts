/**
 * First-party Smart Extension: Aquilla's DEFAULT translation editor, rebuilt
 * as an extension to prove the extension API can carry the whole editing
 * experience. It runs exactly like any other extension — sandboxed opaque-
 * origin iframe, no network, every read and write through `aquilla.*`, every
 * write an ordinary event with tool provenance — and it is installed in each
 * project by the server (POST /tools/first-party), not by the client, so its
 * source is the reviewed code in this repo. Its scopes are AUTO-GRANTED on
 * first use (stated on the editor bar and the management page); revoking them
 * on the Smart Extensions page sticks.
 */

import type { ToolManifest } from "../manifest"
import { DEFAULT_EDITOR_SCRIPT } from "./default-editor-script"
import { DEFAULT_EDITOR_STYLE } from "./default-editor-style"

export const FIRST_PARTY_DEFAULT_EDITOR = "default-editor"

export const DEFAULT_EDITOR_MANIFEST: ToolManifest = {
  name: "Aquilla Editor",
  description:
    "The standard translation editor, as a first-party extension: source and target side by side, rich text, validate, live edits and presence, comments and audio.",
  scopes: ["read:cells", "write:target", "write:validation", "read:comments"],
  mounts: ["page", "editor"],
  apiRev: 2,
}

export const DEFAULT_EDITOR_SOURCE = `<!doctype html>
<html>
<head>
<style>${DEFAULT_EDITOR_STYLE}</style>
</head>
<body>
<script>${DEFAULT_EDITOR_SCRIPT}</script>
</body>
</html>`

export interface FirstPartyTool {
  key: string
  manifest: ToolManifest
  source: string
}

export const FIRST_PARTY_TOOLS: Readonly<Record<string, FirstPartyTool>> = {
  [FIRST_PARTY_DEFAULT_EDITOR]: {
    key: FIRST_PARTY_DEFAULT_EDITOR,
    manifest: DEFAULT_EDITOR_MANIFEST,
    source: DEFAULT_EDITOR_SOURCE,
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
