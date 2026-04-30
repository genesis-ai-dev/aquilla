import { useCallback, useEffect, useRef, useState } from "react";
import { useFrontierSession } from "./useFrontierSession";
import { useAccessibleProjects } from "./useAccessibleProjects";
import { listProjectMembers, type ProjectMember } from "@/lib/frontier/members";
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects";

export interface MatrixMember {
  userId: number;
  username: string;
  /** True when this user has zero direct project_members rows but appears in
   * the matrix solely because they're an org member (i.e. inherits role on
   * every project via org tier). Used to render that row distinctly. */
  isOrgInherited: boolean;
}

export interface MatrixCell {
  /** Effective role at the (member, project) intersection. Absent = no
   * access. The `source` discriminates whether this is a project-level
   * override, an org-inherited grant, or the project creator's implicit
   * ownership. */
  role: ProjectMember["role"];
}

export interface MembersMatrix {
  /** Column headers, in stable order. Whatever fetchAccessibleProjects returns. */
  projects: CloudProjectSummary[];
  /** Row members, in stable order. Sorted by username for predictable scanning. */
  members: MatrixMember[];
  /** Sparse 2D map: cells.get(userId)?.get(projectId). Absence = no access. */
  cells: Map<number, Map<string, MatrixCell>>;
  /** projectId → number of distinct project_members rows. Useful for
   * concentration-risk hints ("only one Owner on Genesis"). */
  ownerCountByProject: Map<string, number>;
}

export interface UseProjectsMembersMatrix {
  matrix: MembersMatrix | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Pulls members for every accessible project in parallel, then aggregates
 * into a sparse {userId → projectId → role} map for the Matrix view.
 *
 * Why fan-out per project instead of one batched endpoint: frontier-server
 * doesn't currently expose a "members across the org" endpoint, and
 * adding one for v1 isn't worth the round-trip. With Promise.all over
 * accessibleProjects we get O(1) wall-clock latency for typical org sizes
 * (< 30 projects). When the matrix gets too large to render anyway, the
 * UI will need filters before the round-trip count becomes the bottleneck.
 *
 * Skipped when there's no JWT or no projects to summarize.
 */
export function useProjectsMembersMatrix(): UseProjectsMembersMatrix {
  const { session } = useFrontierSession();
  const jwt = session?.jwt ?? null;
  const { projects } = useAccessibleProjects();
  const [matrix, setMatrix] = useState<MembersMatrix | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  // Reset aliveRef on each effect run — see useOrg for the StrictMode
  // rationale (cleanup-only would permanently flip it false in dev).
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!jwt) {
      if (aliveRef.current) {
        setMatrix(null);
        setError(null);
      }
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // Fan out one /members fetch per accessible project. listProjectMembers
      // returns null on 403/404, which we collapse to an empty list — those
      // shouldn't block the rest of the matrix.
      const perProjectMembers = await Promise.all(
        projects.map(async (p) => ({
          project: p,
          members: (await listProjectMembers(jwt, p.id)) ?? [],
        }))
      );

      // Build the sparse cell map and the deduped member list in one pass.
      const cells = new Map<number, Map<string, MatrixCell>>();
      const memberByUserId = new Map<number, MatrixMember>();
      const ownerCountByProject = new Map<string, number>();

      for (const { project, members } of perProjectMembers) {
        let ownerCount = 0;
        for (const m of members) {
          // Track the user as a row.
          if (!memberByUserId.has(m.userId)) {
            memberByUserId.set(m.userId, {
              userId: m.userId,
              username: m.username,
              isOrgInherited: m.role.source === "org",
            });
          } else {
            // If we've seen this user via override or creator on any project,
            // they're not purely org-inherited.
            if (m.role.source !== "org") {
              const existing = memberByUserId.get(m.userId)!;
              if (existing.isOrgInherited) {
                memberByUserId.set(m.userId, { ...existing, isOrgInherited: false });
              }
            }
          }

          // Cell.
          if (!cells.has(m.userId)) cells.set(m.userId, new Map());
          cells.get(m.userId)!.set(project.id, { role: m.role });

          if (m.role.level >= 700) ownerCount++;
        }
        ownerCountByProject.set(project.id, ownerCount);
      }

      const sortedMembers = [...memberByUserId.values()].sort((a, b) =>
        a.username.localeCompare(b.username)
      );

      if (aliveRef.current) {
        setMatrix({
          projects,
          members: sortedMembers,
          cells,
          ownerCountByProject,
        });
      }
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [jwt, projects]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { matrix, isLoading, error, refresh };
}
