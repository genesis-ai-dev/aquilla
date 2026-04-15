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

export async function listGroupProjects(
  session: FrontierSession, groupId: number
): Promise<GitlabProject[]> {
  const res = await fetch(
    `${session.gitlabUrl}/api/v4/groups/${groupId}/projects?per_page=100&include_subgroups=true`,
    { headers: { "PRIVATE-TOKEN": session.gitlabToken } }
  );
  const payload = await json<unknown>(res);
  return unwrapList<GitlabProject>(payload);
}

export async function listAllProjects(session: FrontierSession): Promise<GitlabProject[]> {
  const groups = await listGroups(session);
  const batches = await Promise.all(groups.map(g => listGroupProjects(session, g.id).catch(() => [])));
  const all = batches.flat();
  const seen = new Set<number>();
  return all.filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}
