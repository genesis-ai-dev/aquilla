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
  total?: number;        // from X-Total header (when CORS exposes it)
  totalPages?: number;   // from X-Total-Pages
  nextPage?: number;     // from X-Next-Page (empty/missing on last page)
  prevPage?: number;
}

function parseNumHeader(res: Response, name: string): number | undefined {
  const v = res.headers.get(name);
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
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
  return {
    items,
    page,
    perPage,
    total: parseNumHeader(res, "x-total"),
    totalPages: parseNumHeader(res, "x-total-pages"),
    nextPage: parseNumHeader(res, "x-next-page"),
    prevPage: parseNumHeader(res, "x-prev-page"),
  };
}

