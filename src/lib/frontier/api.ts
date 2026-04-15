import { FRONTIER_BASE } from "./auth";
import type { FrontierSession, FrontierGroup, GitlabProject } from "./types";

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function listGroups(session: FrontierSession): Promise<FrontierGroup[]> {
  const res = await fetch(`${FRONTIER_BASE}/api/v1/portal/groups?per_page=100`, {
    headers: { Authorization: `Bearer ${session.jwt}` },
  });
  return json<FrontierGroup[]>(res);
}

export async function listGroupProjects(
  session: FrontierSession, groupId: number
): Promise<GitlabProject[]> {
  const res = await fetch(
    `${session.gitlabUrl}/api/v4/groups/${groupId}/projects?per_page=100&include_subgroups=true`,
    { headers: { "PRIVATE-TOKEN": session.gitlabToken } }
  );
  return json<GitlabProject[]>(res);
}

export async function listAllProjects(session: FrontierSession): Promise<GitlabProject[]> {
  const groups = await listGroups(session);
  const batches = await Promise.all(groups.map(g => listGroupProjects(session, g.id).catch(() => [])));
  const all = batches.flat();
  const seen = new Set<number>();
  return all.filter(p => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}
