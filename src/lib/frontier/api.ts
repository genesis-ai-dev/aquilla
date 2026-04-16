import { FRONTIER_BASE } from "./auth";
import type { FrontierSession, FrontierGroup, GitlabProject } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

// Frontier's portal/groups endpoint has returned at least two shapes across
// versions: a bare array and a paginated wrapper like {data,total,page,...} or
// {groups,total,...}. Unwrap defensively and log the raw shape on mismatch so
// future drift is easy to spot.
function unwrapList<T>(payload: unknown, keys: string[] = ["data", "items", "results", "groups", "projects"]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    for (const k of keys) {
      const v = (payload as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  console.warn("[frontier] unexpected list response shape:", payload);
  return [];
}

export async function listGroups(session: FrontierSession): Promise<FrontierGroup[]> {
  const res = await fetch(`${FRONTIER_BASE}/api/v1/portal/groups?per_page=100`, {
    headers: { Authorization: `Bearer ${session.jwt}` },
  });
  const payload = await json<unknown>(res);
  return unwrapList<FrontierGroup>(payload);
}

export interface ProjectsPage {
  items: GitlabProject[];
  page: number;
  perPage: number;
  total?: number;        // from X-Total header or wrapper.total
  totalPages?: number;   // from X-Total-Pages
  nextPage?: number;     // from X-Next-Page or derived from has_more
  prevPage?: number;
  hasMore?: boolean;     // from wrapper.has_more (Frontier-style)
}

function parseNumHeader(res: Response, name: string): number | undefined {
  const v = res.headers.get(name);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface PaginatedWrapper<T> {
  total?: number;
  page?: number;
  per_page?: number;
  has_more?: boolean;
  data?: T[];
  items?: T[];
  results?: T[];
  groups?: T[];
  projects?: T[];
}

function readPagination<T>(payload: unknown, items: T[], res: Response, page: number, perPage: number): ProjectsPage {
  const w = (payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as PaginatedWrapper<T>
    : {}) as PaginatedWrapper<T>;
  const total = parseNumHeader(res, "x-total") ?? w.total;
  const totalPages = parseNumHeader(res, "x-total-pages")
    ?? (total != null ? Math.ceil(total / perPage) : undefined);
  const nextPageHeader = parseNumHeader(res, "x-next-page");
  const nextPage = nextPageHeader
    ?? (w.has_more ? page + 1
      : (totalPages != null && page < totalPages ? page + 1 : undefined));
  return {
    items: items as unknown as GitlabProject[],
    page,
    perPage,
    total,
    totalPages,
    nextPage,
    prevPage: parseNumHeader(res, "x-prev-page") ?? (page > 1 ? page - 1 : undefined),
    hasMore: w.has_more,
  };
}

// All projects the user can access, paginated. Server side: GitLab's
// /api/v4/projects?membership=true. Much friendlier than walking groups.
export async function listMyProjectsPage(
  session: FrontierSession, page: number, perPage = 20, search?: string
): Promise<ProjectsPage> {
  const params = new URLSearchParams({
    membership: "true",
    simple: "true",
    per_page: String(perPage),
    page: String(page),
    order_by: "last_activity_at",
    sort: "desc",
  });
  if (search?.trim()) {
    params.set("search", search.trim());
    // Include namespace paths in the server-side search (GitLab >= 9.5),
    // so "writer" matches a project under group/writer/, not just project names.
    params.set("search_namespaces", "true");
  }
  const url = `${session.gitlabUrl}/api/v4/projects?${params}`;
  const res = await fetch(url, {
    headers: { "PRIVATE-TOKEN": session.gitlabToken },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const payload = (await res.json()) as unknown;
  const items = unwrapList<GitlabProject>(payload);
  return readPagination<GitlabProject>(payload, items, res, page, perPage);
}

// Fetch full project details (including .permissions) — simple=true in the
// listing strips them, so we re-fetch on import.
export async function getProject(
  session: FrontierSession, projectId: number
): Promise<GitlabProject> {
  const res = await fetch(
    `${session.gitlabUrl}/api/v4/projects/${projectId}`,
    { headers: { "PRIVATE-TOKEN": session.gitlabToken } }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return await res.json() as GitlabProject;
}

export async function listGroupProjectsPage(
  session: FrontierSession, groupId: number, page: number, perPage = 50
): Promise<ProjectsPage> {
  const url = `${session.gitlabUrl}/api/v4/groups/${groupId}/projects?per_page=${perPage}&page=${page}&include_subgroups=true&order_by=path&sort=asc`;
  const res = await fetch(url, {
    headers: { "PRIVATE-TOKEN": session.gitlabToken },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const payload = (await res.json()) as unknown;
  const items = unwrapList<GitlabProject>(payload);
  return readPagination<GitlabProject>(payload, items, res, page, perPage);
}

