// RC (Resource Container) manifest.yaml parsing (spec §4).
//
// The manifest is how the adapter routes a Door43 repo to a parser + cell-id
// rule WITHOUT hardcoding repo names: dublin_core.{type,subject,format} pick the
// ResourceRoute, and projects[] enumerate the files to fetch/parse.

import { parse as parseYaml } from "yaml"
import type { DcsManifest } from "./types"

interface RawManifest {
  dublin_core?: {
    type?: string
    subject?: string
    format?: string
    identifier?: string
    language?: { identifier?: string; title?: string; direction?: string }
  }
  projects?: Array<{
    identifier?: string
    path?: string
    title?: string
    sort?: number
  }>
}

/**
 * Parse an RC manifest.yaml into the routed `DcsManifest` shape. Throws if the
 * document has no `dublin_core` block (not a valid RC manifest — fail loud so a
 * bad fetch surfaces instead of silently routing to nothing).
 */
export function parseManifest(yamlText: string): DcsManifest {
  const raw = parseYaml(yamlText) as RawManifest | null
  const dc = raw?.dublin_core
  if (!dc) {
    throw new Error("Invalid RC manifest: missing dublin_core block")
  }

  return {
    rcType: dc.type ?? "",
    subject: dc.subject ?? "",
    format: dc.format ?? "",
    identifier: dc.identifier ?? "",
    language: {
      identifier: dc.language?.identifier ?? "",
      title: dc.language?.title ?? "",
      direction: dc.language?.direction ?? "ltr",
    },
    projects: (raw?.projects ?? []).map((p) => ({
      identifier: p.identifier ?? "",
      path: p.path ?? "",
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.sort !== undefined ? { sort: p.sort } : {}),
    })),
  }
}
