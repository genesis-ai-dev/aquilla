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

export async function listGroupProjectsPage(
  session: FrontierSession, groupId: number, page: number, perPage = 50
): Promise<GitlabProject[]> {
  const res = await fetch(
    `${session.gitlabUrl}/api/v4/groups/${groupId}/projects?per_page=${perPage}&page=${page}&include_subgroups=true&order_by=path&sort=asc`,
    { headers: { "PRIVATE-TOKEN": session.gitlabToken } }
  );
  const payload = await json<unknown>(res);
  return unwrapList<GitlabProject>(payload);
}

export async function listGroupProjects(
  session: FrontierSession, groupId: number
): Promise<GitlabProject[]> {
  return listGroupProjectsPage(session, groupId, 1, 100);
}

// Fetches every page of projects in a group and returns the merged array.
export async function listAllGroupProjects(
  session: FrontierSession, groupId: number, perPage = 50
): Promise<GitlabProject[]> {
  const out: GitlabProject[] = [];
  let page = 1;
  while (true) {
    const batch = await listGroupProjectsPage(session, groupId, page, perPage);
    out.push(...batch);
    if (batch.length < perPage) break;
    page++;
    if (page > 100) break; // safety: 5000 projects per group cap
  }
  return out;
}

