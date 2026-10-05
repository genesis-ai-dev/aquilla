// What a built-in check may need beyond the cell's own text, supplied by the
// caller that knows it. AQU-1573 added the first one: the lane's reference
// Bible, for the "Reference Bible quotes" check. Callers that pass no context
// (proposal cards, the rules preview) get exactly the old behaviour, and a
// check that needs a context finds nothing without it.

import type { InfractionSpan } from "@/lib/parsers/types"
import type { ReferenceQuoteLookup } from "@/lib/reference-bible/quote-check"
import type { FoundReference } from "@/lib/reference-bible/types"

export interface BuiltinCheckContext {
  referenceBible?: {
    /** Shown in the warning ("does not match Van Dyck word for word"). */
    versionName: string
    /** Verse texts of a canonical reference; undefined while not loaded. */
    lookup: ReferenceQuoteLookup
    /** The explicit references in a source text, memoised by the caller. */
    references?: (source: string) => readonly FoundReference[]
  }
}

/** Spans alone, or spans plus the values the localized reason interpolates. */
export type BuiltinCheckResult =
  | InfractionSpan[]
  | { spans: InfractionSpan[]; params: Record<string, string> }
  | null
