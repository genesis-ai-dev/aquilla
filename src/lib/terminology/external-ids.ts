// A concept's links to records outside the termbase (AQU-1693): today only
// `acai`, the ACAI entity the concept names ("person:Jesus.2").
//
// Every way in (a term.* payload, a JSONB row, a TBX import) goes through
// `coerceExternalIds`, because a link decides whose name a rendering becomes:
// a malformed value must never turn into a link.
//
// Relative imports only: the sync-worker projection imports this module.

import type { ConceptExternalIds } from "./model"

/** "person:Jesus.2", "place:Jerusalem", "keyterm:Life.2": a type, a colon, no spaces. */
const ACAI_ID = /^[A-Za-z][A-Za-z-]*:\S+$/
const MAX_ACAI_ID_LENGTH = 200

/** A well-formed ACAI id, trimmed; null when `value` is not one. */
export function acaiIdOf(value: unknown): string | null {
  if (typeof value !== "string") return null
  const id = value.trim()
  return id.length <= MAX_ACAI_ID_LENGTH && ACAI_ID.test(id) ? id : null
}

/**
 * The links in `raw` (an object, or its JSON text), or undefined when `raw`
 * is not a links object. `{}` stays `{}`: it is how an update says "unlink".
 * Unknown keys are dropped.
 */
export function coerceExternalIds(raw: unknown): ConceptExternalIds | undefined {
  let value = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const acaiRaw = (value as { acai?: unknown }).acai
  if (acaiRaw === undefined) return {}
  const acai = acaiIdOf(acaiRaw)
  return acai ? { acai } : undefined
}

/** The same link, comparing values; an absent object and `{}` are both "no link". */
export function sameExternalIds(a: ConceptExternalIds | undefined, b: ConceptExternalIds | undefined): boolean {
  return (a?.acai ?? null) === (b?.acai ?? null)
}
