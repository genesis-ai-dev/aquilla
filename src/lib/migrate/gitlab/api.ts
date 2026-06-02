// GitLab REST helpers + Codex-project detection for the migration fetcher.
//
// Ported (headless, fetch-only) from the VS Code extension's
//   frontier-authentication/src/gitlab/GitLabService.ts
//     - listProjects()        -> listProjects() here (membership + pagination)
//     - getRepositoryFile()   -> getRepositoryFileRaw() here
//     - getRepositoryTree()   -> getRepositoryTree() here
//
// The GitLab project list does NOT flag Codex projects, so we detect them by
// fetching the root metadata.json and checking for the Scripture-Burrito-ish
// shape codex-editor writes (projectName / meta / languages). Verified against
// real on-disk projects, e.g. ~/.codex-projects/<...>/metadata.json which carry
// { format: "scripture burrito", projectName, meta: {...}, languages: [...] }.
// Note projectName can be empty, so ANY of the three keys is sufficient.

import type { GitLabCredentials } from "./auth"

/** Subset of a GitLab project relevant to discovery + clone. */
export interface GitLabProject {
  id: number
  name: string
  path_with_namespace: string
  default_branch: string | null
  http_url_to_repo: string
  last_activity_at: string
  namespace?: { id: number; name: string; path: string; full_path?: string }
}

/** A GitLab project confirmed to be a Codex project. */
export interface CodexProjectMatch {
  id: number
  name: string
  namespace: string
  lastActivityAt: string
  httpUrlToRepo: string
  defaultBranch: string
}

/**
 * Read GitLab's `X-Next-Page` keyset-pagination header. Returns the parsed page
 * number, or null when absent/blank (the signal to stop paginating). Pure —
 * unit-tested directly. Accepts any object with a Headers-like `get`.
 */
export function parseNextPage(headers: {
  get(name: string): string | null
}): number | null {
  const raw = headers.get("X-Next-Page") ?? headers.get("x-next-page")
  if (raw === null) return null
  const trimmed = raw.trim()
  if (trimmed === "") return null
  const page = Number(trimmed)
  if (!Number.isInteger(page) || page <= 0) return null
  return page
}

/**
 * List GitLab projects, newest-activity first, following `X-Next-Page` until
 * exhausted. By default lists ALL projects visible to the token — for an admin
 * / root token that's every project on the instance (the bulk-migration case).
 * Pass `membershipOnly` to restrict to the token's memberships. Optional `search`.
 */
export async function listProjects(
  creds: GitLabCredentials,
  options: { search?: string; membershipOnly?: boolean } = {},
): Promise<GitLabProject[]> {
  const all: GitLabProject[] = []
  let page: number | null = 1

  while (page !== null) {
    const params = new URLSearchParams({
      per_page: "100",
      order_by: "last_activity_at",
      sort: "desc",
      page: String(page),
    })
    if (options.membershipOnly) params.set("membership", "true")
    if (options.search) params.set("search", options.search)

    const url = `${creds.gitlabUrl}/api/v4/projects?${params.toString()}`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.gitlabToken}` },
    })
    if (!response.ok) {
      throw new Error(
        `Failed to list GitLab projects (${response.status} ${response.statusText})`,
      )
    }

    const batch = (await response.json()) as GitLabProject[]
    all.push(...batch)
    page = parseNextPage(response.headers)
  }

  return all
}

/**
 * Fetch one repository file's raw bytes-as-text via the Files API.
 * Returns null on 404 (file absent) so callers can probe without throwing.
 * The file path is URL-encoded (so "metadata.json" -> "metadata.json", but
 * nested paths like ".project/x" survive encoding too).
 */
export async function getRepositoryFileRaw(
  creds: GitLabCredentials,
  projectId: number | string,
  filePath: string,
  ref: string,
): Promise<string | null> {
  const encodedPath = encodeURIComponent(filePath)
  const url =
    `${creds.gitlabUrl}/api/v4/projects/${encodeURIComponent(String(projectId))}` +
    `/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.gitlabToken}` },
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${filePath} from project ${projectId} ` +
        `(${response.status} ${response.statusText})`,
    )
  }
  return response.text()
}

/** A single entry from the repository tree listing. */
export interface RepoTreeEntry {
  id: string
  name: string
  path: string
  type: "blob" | "tree"
  mode: string
}

/**
 * List a repository directory (recursively by default), following GitLab's
 * page-number pagination. Used to confirm `.project/attachments` exists as a
 * secondary Codex signal. Returns [] when the path is absent (404).
 */
export async function getRepositoryTree(
  creds: GitLabCredentials,
  projectId: number | string,
  treePath: string,
  ref: string,
  recursive = true,
): Promise<RepoTreeEntry[]> {
  const entries: RepoTreeEntry[] = []
  let page = 1
  const perPage = 100

  for (;;) {
    const params = new URLSearchParams({
      path: treePath,
      ref,
      recursive: String(recursive),
      per_page: String(perPage),
      page: String(page),
    })
    const url =
      `${creds.gitlabUrl}/api/v4/projects/${encodeURIComponent(String(projectId))}` +
      `/repository/tree?${params.toString()}`

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.gitlabToken}` },
    })
    if (response.status === 404) return entries
    if (!response.ok) {
      throw new Error(
        `Failed to list tree ${treePath} for project ${projectId} ` +
          `(${response.status} ${response.statusText})`,
      )
    }

    const batch = (await response.json()) as RepoTreeEntry[]
    entries.push(...batch)
    if (batch.length < perPage) break
    page += 1
  }

  return entries
}

/**
 * Decide whether a parsed metadata.json looks like a Codex project. Pure +
 * unit-tested. The shape codex-editor writes always carries at least one of
 * projectName / meta / languages; we treat presence of any as a match (and
 * require it to be a JSON object, not an array/primitive). projectName may be
 * an empty string in real exports, so its mere presence as a string key counts.
 */
export function isCodexMetadata(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false
  }
  const obj = parsed as Record<string, unknown>
  const hasProjectName = typeof obj.projectName === "string"
  const hasMeta = typeof obj.meta === "object" && obj.meta !== null
  const hasLanguages = Array.isArray(obj.languages)
  return hasProjectName || hasMeta || hasLanguages
}

/**
 * Probe one project for Codex-ness: fetch root metadata.json on its default
 * branch and test the shape; fall back to checking `.project/attachments` in
 * the tree if metadata.json is absent/unparseable. Returns a match descriptor
 * or null. Network/parse errors degrade to null (never throw) so a single bad
 * project can't abort a full discovery scan.
 */
export async function detectCodexProject(
  creds: GitLabCredentials,
  project: GitLabProject,
): Promise<CodexProjectMatch | null> {
  const ref = project.default_branch ?? "main"

  try {
    const raw = await getRepositoryFileRaw(creds, project.id, "metadata.json", ref)
    if (raw !== null) {
      try {
        if (isCodexMetadata(JSON.parse(raw))) {
          return toMatch(project, ref)
        }
      } catch {
        // metadata.json present but not JSON -> fall through to tree probe
      }
    }

    // Secondary signal: a Codex repo keeps media under .project/attachments.
    const tree = await getRepositoryTree(
      creds,
      project.id,
      ".project/attachments",
      ref,
      false,
    )
    if (tree.length > 0) {
      return toMatch(project, ref)
    }
  } catch {
    // Treat any probe failure as "not detectable as Codex".
    return null
  }

  return null
}

function toMatch(project: GitLabProject, ref: string): CodexProjectMatch {
  return {
    id: project.id,
    name: project.name,
    namespace: project.namespace?.full_path ?? project.path_with_namespace,
    lastActivityAt: project.last_activity_at,
    httpUrlToRepo: project.http_url_to_repo,
    defaultBranch: ref,
  }
}

/**
 * Discover all accessible Codex projects: list (optionally filtered by search),
 * then probe each in parallel-bounded fashion. Returns only confirmed matches.
 */
export async function discoverCodexProjects(
  creds: GitLabCredentials,
  options: { search?: string; concurrency?: number } = {},
): Promise<CodexProjectMatch[]> {
  const projects = await listProjects(creds, { search: options.search })
  const concurrency = options.concurrency ?? 8
  const matches: CodexProjectMatch[] = []

  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++
      if (index >= projects.length) return
      const match = await detectCodexProject(creds, projects[index])
      if (match) matches.push(match)
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, projects.length) },
    () => worker(),
  )
  await Promise.all(workers)

  // Preserve the server's last-activity ordering (workers race, so re-sort).
  matches.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
  return matches
}

/**
 * Resolve a user-supplied selector (numeric id OR free-text search term) to a
 * single project to clone. Numeric ids are fetched directly; text terms run a
 * Codex-filtered search and require an unambiguous single match.
 */
export async function resolveProjectSelector(
  creds: GitLabCredentials,
  selector: string,
): Promise<CodexProjectMatch> {
  if (/^\d+$/.test(selector.trim())) {
    const id = Number(selector.trim())
    const project = await getProjectById(creds, id)
    if (!project) {
      throw new Error(`GitLab project ${id} not found or not accessible.`)
    }
    const match = await detectCodexProject(creds, project)
    // Allow id-based clone even if detection is uncertain — the user asked for
    // this exact project by id. Synthesize a match from the project metadata.
    return match ?? toMatch(project, project.default_branch ?? "main")
  }

  const matches = await discoverCodexProjects(creds, { search: selector })
  if (matches.length === 0) {
    throw new Error(`No accessible Codex project matched "${selector}".`)
  }
  if (matches.length > 1) {
    const list = matches
      .map((m) => `  ${m.id}  ${m.name}  (${m.namespace})`)
      .join("\n")
    throw new Error(
      `"${selector}" matched ${matches.length} Codex projects. ` +
        `Re-run with a specific project id:\n${list}`,
    )
  }
  return matches[0]
}

// ── Groups (for the org/team/member migration) ─────────────────────────────
//
// scripts/migrate-groups.ts walks the GitLab group tree:
//   top-level groups        → orgs
//   descendant subgroups    → teams (flattened)
//   direct members per group → org/team membership
// All three follow the same `X-Next-Page` keyset pagination as listProjects.

/** A GitLab group/subgroup (subset). `parent_id` is null for top-level groups. */
export interface GitLabGroupRaw {
  id: number
  name: string
  full_path: string
  parent_id: number | null
}

/** A GitLab group membership row (subset). `access_level` is 10..50. */
export interface GitLabMemberRaw {
  id: number
  username: string
  access_level: number
}

async function listPaged<T>(creds: GitLabCredentials, pathAndQuery: string): Promise<T[]> {
  const all: T[] = []
  let page: number | null = 1
  while (page !== null) {
    const sep = pathAndQuery.includes("?") ? "&" : "?"
    const url = `${creds.gitlabUrl}/api/v4/${pathAndQuery}${sep}per_page=100&page=${page}`
    const response = await fetch(url, { headers: { Authorization: `Bearer ${creds.gitlabToken}` } })
    if (!response.ok) {
      throw new Error(`GitLab GET ${pathAndQuery} failed (${response.status} ${response.statusText})`)
    }
    all.push(...((await response.json()) as T[]))
    page = parseNextPage(response.headers)
  }
  return all
}

/** All top-level groups visible to the token (the org candidates). */
export async function listTopLevelGroups(creds: GitLabCredentials): Promise<GitLabGroupRaw[]> {
  return listPaged<GitLabGroupRaw>(creds, "groups?top_level_only=true&all_available=true")
}

/** All descendant subgroups of a group, flattened (any depth). */
export async function listDescendantGroups(
  creds: GitLabCredentials,
  groupId: number,
): Promise<GitLabGroupRaw[]> {
  return listPaged<GitLabGroupRaw>(creds, `groups/${groupId}/descendant_groups`)
}

/** Direct members of a group (NOT inherited — use for both orgs and teams). */
export async function listGroupMembers(
  creds: GitLabCredentials,
  groupId: number,
): Promise<GitLabMemberRaw[]> {
  return listPaged<GitLabMemberRaw>(creds, `groups/${groupId}/members`)
}

/** A GitLab user (subset). `email` is only populated for an admin token. */
export interface GitLabUserRaw {
  id: number
  username: string
  email: string | null
}

/**
 * List ALL GitLab users (admin token only — needed for the email field, which
 * the members API omits). Email is the reliable join key to aquilla users:
 * GitLab usernames have drifted from Frontier usernames (e.g. GitLab
 * "Luke_Bilhorn" ↔ aquilla "Luke"), but emails match.
 */
export async function listAllUsers(creds: GitLabCredentials): Promise<GitLabUserRaw[]> {
  return listPaged<GitLabUserRaw>(creds, "users")
}

/** Fetch a single project by numeric id. Returns null on 404. */
export async function getProjectById(
  creds: GitLabCredentials,
  id: number,
): Promise<GitLabProject | null> {
  const url = `${creds.gitlabUrl}/api/v4/projects/${id}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.gitlabToken}` },
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(
      `Failed to fetch project ${id} (${response.status} ${response.statusText})`,
    )
  }
  return (await response.json()) as GitLabProject
}
