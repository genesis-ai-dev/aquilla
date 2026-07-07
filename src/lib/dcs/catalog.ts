// Typed client for git.door43.org — the DCS Catalog (released-version index) +
// the underlying Gitea repo API (spec §6, §7). All endpoints send
// `access-control-allow-origin: *`, so this runs client-side in the SPA with no
// proxy. Every method takes an injectable `fetchImpl` (default global fetch) so
// tests mock the network entirely.

import type { DcsCatalogEntry, DcsCompareResult } from "./types"

/** Catalog + Gitea API base (JSON endpoints). */
export const DEFAULT_DCS_BASE = "https://git.door43.org/api/v1"
/** Raw file host (blob bytes). Distinct from the API base — no `/api/v1`. */
export const DEFAULT_DCS_RAW_BASE = "https://git.door43.org"

/** Ref kind for raw-file URLs: tags resolve under raw/tag/, branches under raw/branch/. */
export type RefKind = "tag" | "branch"

export interface DcsClientOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Override the API base (e.g. a mirror). Defaults to git.door43.org. */
  baseUrl?: string
  /** Override the raw-file host. Defaults to git.door43.org. */
  rawBaseUrl?: string
}

/** Params accepted by /catalog/search. All optional; passed through verbatim
 *  as query-string values. */
export interface CatalogSearchParams {
  lang?: string
  subject?: string
  owner?: string
  repo?: string
  /** Release stage, e.g. "prod" | "preprod" | "draft" | "latest". */
  stage?: string
  contentFormat?: string
  q?: string
  limit?: number
}

// ── Raw DCS response shapes (snake_case) we normalize from ──────────────────

interface RawCatalogEntry {
  name?: string
  owner?: string
  full_name?: string
  subject?: string
  content_format?: string
  flavor_type?: string
  branch_or_tag_name?: string
  ref_type?: string
  commit_sha?: string
  released?: string
  zipball_url?: string
  // DCS misspells the archive URL as "tarbar_url" (sic). Fall back to zipball_url.
  tarbar_url?: string
  metadata_url?: string
  language?: string
  language_title?: string
  language_direction?: string
}

interface RawCompare {
  total_commits?: number
  // NOTE: DCS's Gitea leaves this EMPTY. Do not read it (spec §6).
  files?: Array<{ filename?: string }>
  commits?: Array<{ files?: Array<{ filename?: string }> }>
}

interface RawTree {
  tree?: Array<{ path?: string; type?: string }>
}

function normalizeEntry(r: RawCatalogEntry): DcsCatalogEntry {
  return {
    name: r.name ?? "",
    owner: r.owner ?? "",
    fullName: r.full_name ?? `${r.owner ?? ""}/${r.name ?? ""}`,
    subject: r.subject ?? "",
    contentFormat: r.content_format ?? "",
    ...(r.flavor_type !== undefined ? { flavorType: r.flavor_type } : {}),
    ref: r.branch_or_tag_name ?? "",
    ...(r.ref_type !== undefined ? { refType: r.ref_type } : {}),
    commitSha: r.commit_sha ?? "",
    released: r.released ?? "",
    // Prefer the (correct) zipball_url; fall back to the [sic] tarbar_url.
    zipballUrl: r.zipball_url ?? r.tarbar_url ?? "",
    metadataUrl: r.metadata_url ?? "",
    language: r.language ?? "",
    ...(r.language_title !== undefined ? { languageTitle: r.language_title } : {}),
    ...(r.language_direction !== undefined
      ? { languageDirection: r.language_direction }
      : {}),
  }
}

export class DcsClient {
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly rawBaseUrl: string

  constructor(opts: DcsClientOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.baseUrl = (opts.baseUrl ?? DEFAULT_DCS_BASE).replace(/\/$/, "")
    this.rawBaseUrl = (opts.rawBaseUrl ?? DEFAULT_DCS_RAW_BASE).replace(/\/$/, "")
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url)
    if (!res.ok) {
      const detail = await res.text().catch(() => "")
      throw new Error(
        `DCS request failed (HTTP ${res.status}) for ${url}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      )
    }
    return (await res.json()) as T
  }

  /** GET /catalog/search — released resources matching the filters. */
  async searchCatalog(params: CatalogSearchParams = {}): Promise<DcsCatalogEntry[]> {
    const qs = new URLSearchParams()
    if (params.lang) qs.set("lang", params.lang)
    if (params.subject) qs.set("subject", params.subject)
    if (params.owner) qs.set("owner", params.owner)
    if (params.repo) qs.set("repo", params.repo)
    if (params.stage) qs.set("stage", params.stage)
    if (params.contentFormat) qs.set("metadataType", params.contentFormat)
    if (params.q) qs.set("q", params.q)
    if (params.limit !== undefined) qs.set("limit", String(params.limit))

    const data = await this.getJson<{ data?: RawCatalogEntry[] }>(
      `${this.baseUrl}/catalog/search?${qs.toString()}`,
    )
    return (data.data ?? []).map(normalizeEntry)
  }

  /** GET /catalog/entry/{owner}/{repo}/{ref} — one released resource, normalized. */
  async getCatalogEntry(owner: string, repo: string, ref: string): Promise<DcsCatalogEntry> {
    const raw = await this.getJson<RawCatalogEntry>(
      `${this.baseUrl}/catalog/entry/${owner}/${repo}/${ref}`,
    )
    return normalizeEntry(raw)
  }

  /**
   * GET /repos/{owner}/{repo}/compare/{old}...{new}.
   *
   * changedFiles is the UNIQUE UNION of `.commits[].files[].filename`. DCS's
   * Gitea leaves the response's top-level `.files` empty (spec §6), so reading
   * that would report zero changes — the per-commit union is the real set.
   */
  async compareRefs(
    owner: string,
    repo: string,
    oldRef: string,
    newRef: string,
  ): Promise<DcsCompareResult> {
    const raw = await this.getJson<RawCompare>(
      `${this.baseUrl}/repos/${owner}/${repo}/compare/${oldRef}...${newRef}`,
    )
    const changed = new Set<string>()
    for (const commit of raw.commits ?? []) {
      for (const f of commit.files ?? []) {
        if (f.filename) changed.add(f.filename)
      }
    }
    return {
      totalCommits: raw.total_commits ?? (raw.commits?.length ?? 0),
      changedFiles: [...changed],
    }
  }

  /**
   * GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1 — the full tree at a
   * ref. Returns only blob (file) paths; directories are dropped.
   */
  async getTree(owner: string, repo: string, ref: string): Promise<string[]> {
    const raw = await this.getJson<RawTree>(
      `${this.baseUrl}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1&per_page=99999`,
    )
    return (raw.tree ?? [])
      .filter((e) => e.type === "blob" && typeof e.path === "string")
      .map((e) => e.path as string)
  }

  /**
   * GET the raw bytes of one file at a ref. Tags resolve under `raw/tag/{ref}/`,
   * branches under `raw/branch/{ref}/` — the caller supplies the ref kind
   * (a catalog entry's `refType`, defaulting to tag for released resources).
   */
  async fetchRaw(
    owner: string,
    repo: string,
    ref: string,
    path: string,
    refKind: RefKind = "tag",
  ): Promise<string> {
    const url = `${this.rawBaseUrl}/${owner}/${repo}/raw/${refKind}/${ref}/${path}`
    const res = await this.fetchImpl(url)
    if (!res.ok) {
      throw new Error(`DCS raw fetch failed (HTTP ${res.status}) for ${url}`)
    }
    return res.text()
  }
}
