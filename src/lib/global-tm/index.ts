// Global translation-memory retrieval index (Matecat-parity run).
//
// The MyMemory analog: validated translation pairs contributed across the
// whole database, retrievable as few-shot examples for the batch pipeline and
// copilot. INERT until wired into a Worker route behind the `globalFewShot`
// flag (default off, C7) — nothing existing imports this module yet.
//
// TWO NON-BYPASSABLE GOVERNANCE INVARIANTS (goal §3/§4, F6, C8):
//   1. Enterprise exclusion — retrieval NEVER returns an entry whose org is
//      flagged enterprise. Enforced INSIDE retrieve(); there is no option to
//      disable it, and it re-checks flags at read time (defense in depth
//      against entries that predate a flag change).
//   2. TM opt-out — projects with contributeToGlobalTm=false contribute zero
//      writes (write gate) AND any entry of an opted-out project that somehow
//      exists in the store (legacy row, replication bug) is excluded at read.
//
// The store is an injected interface so the Worker can back it with D1/PG
// (cells_fts / value_tsv) while tests use the in-memory implementation.

export interface GlobalTmEntry {
  id: string
  source: string
  target: string
  sourceLang: string
  targetLang: string
  projectId: string
  orgId: string
}

export interface GlobalTmStore {
  insert(entry: GlobalTmEntry): void
  /** Candidate scan for a language pair (the SQL layer would pre-filter). */
  scan(sourceLang: string, targetLang: string): Iterable<GlobalTmEntry>
  size(): number
}

export class InMemoryGlobalTmStore implements GlobalTmStore {
  private entries: GlobalTmEntry[] = []
  insert(entry: GlobalTmEntry): void {
    this.entries.push(entry)
  }
  *scan(sourceLang: string, targetLang: string): Iterable<GlobalTmEntry> {
    const norm = (l: string): string => l.toLowerCase()
    for (const e of this.entries) {
      if (norm(e.sourceLang) === norm(sourceLang) && norm(e.targetLang) === norm(targetLang)) yield e
    }
  }
  /** Test-only backdoor used by leak tests to simulate legacy/buggy rows. */
  unsafeInsertDirect(entry: GlobalTmEntry): void {
    this.entries.push(entry)
  }
  size(): number {
    return this.entries.length
  }
}

export interface GovernanceResolvers {
  /** True when the org is flagged enterprise (org_settings.settings.enterprise). */
  isEnterpriseOrg(orgId: string): boolean
  /** True when the project's EFFECTIVE contributeToGlobalTm is false (C8). */
  isOptedOutProject(projectId: string): boolean
}

export interface ContributionContext {
  projectId: string
  orgId: string
  /** Effective entitlement flag from resolveProjectEntitlements(). */
  contributeToGlobalTm: boolean
}

export interface RetrieveQuery {
  query: string
  sourceLang: string
  targetLang: string
  limit: number
}

const tokenize = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)

const diceSimilarity = (a: string[], b: string[]): number => {
  if (a.length === 0 || b.length === 0) return 0
  const bag = new Map<string, number>()
  for (const t of a) bag.set(t, (bag.get(t) ?? 0) + 1)
  let overlap = 0
  for (const t of b) {
    const n = bag.get(t) ?? 0
    if (n > 0) {
      overlap++
      bag.set(t, n - 1)
    }
  }
  return (2 * overlap) / (a.length + b.length)
}

export class GlobalTmIndex {
  constructor(
    private store: GlobalTmStore,
    private governance: GovernanceResolvers,
  ) {}

  /** Write gate (C8): refuses contributions from opted-out projects. */
  contribute(entry: GlobalTmEntry, ctx: ContributionContext): boolean {
    if (!ctx.contributeToGlobalTm) return false
    this.store.insert({ ...entry, projectId: ctx.projectId, orgId: ctx.orgId })
    return true
  }

  /**
   * Retrieve validated examples ranked by lexical similarity. Enterprise-org
   * and opted-out-project entries are excluded unconditionally — the filter
   * is part of the read path itself, not a caller option (F6).
   */
  retrieve(q: RetrieveQuery): GlobalTmEntry[] {
    const queryTokens = tokenize(q.query)
    const scored: { entry: GlobalTmEntry; score: number }[] = []
    for (const entry of this.store.scan(q.sourceLang, q.targetLang)) {
      if (this.governance.isEnterpriseOrg(entry.orgId)) continue
      if (this.governance.isOptedOutProject(entry.projectId)) continue
      const score = diceSimilarity(queryTokens, tokenize(entry.source))
      if (score > 0) scored.push({ entry, score })
    }
    scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
    return scored.slice(0, Math.max(0, q.limit)).map((s) => s.entry)
  }
}
