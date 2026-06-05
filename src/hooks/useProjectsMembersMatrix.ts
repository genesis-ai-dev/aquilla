import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrontierSession } from "./useFrontierSession";
import { useAccessibleProjects } from "./useAccessibleProjects";
import { useOrg, useOrgMembers } from "./useOrg";
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
  /**
   * Every contributing path whose level > 0 except the winning one.
   * Non-empty when the user reaches the project via multiple paths (e.g. an
   * org-wide viewer who also has a direct contributor override). Used to
   * render the secondary-path icon + tooltip in MembersMatrixCellEditor.
   */
  secondarySources: ProjectMember["secondarySources"];
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
 * Two row sources, unioned:
 *   1. Members returned by listProjectMembers per accessible project —
 *      includes anyone with a project_members row, the project creator,
 *      AND org-tier members (when the project has org_id set).
 *   2. The caller's full org membership list (useOrgMembers) — covers
 *      org members who DON'T appear in source (1) because the project's
 *      org_id is NULL (legacy / un-migrated rows). Without this, an
 *      operator who just added someone as org maintainer wouldn't see
 *      them in the matrix when their projects predate org-binding.
 *      Cells for those members stay empty across projects without org_id —
 *      the truthful state, since the org grant doesn't propagate without
 *      the binding.
 *
 * Skipped when there's no JWT or no projects to summarize.
 */
export function useProjectsMembersMatrix(): UseProjectsMembersMatrix {
  const { session } = useFrontierSession();
  const jwt = session?.jwt ?? null;
  const { projects } = useAccessibleProjects();
  const { state: orgState } = useOrg();
  const orgId = orgState.kind === "success" ? orgState.org.id : null;
  const { members: orgMembers } = useOrgMembers(orgId);
  const [matrix, setMatrix] = useState<MembersMatrix | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  // Stable identity keys so the callback/effect only re-fires when the actual
  // set of IDs changes, not on every render (both arrays are new references
  // every render cycle since they come from useState in their respective hooks).
  const projectsKey = useMemo(
    () => projects.map((p) => p.id).join(","),
    [projects],
  );
  const orgMembersKey = useMemo(
    () => orgMembers.map((m) => m.userId).join(","),
    [orgMembers],
  );

  // Keep refs to the latest values so the callback can read them without
  // them being listed as deps (which would create a new function on every
  // array mutation — defeating the key-based stability above).
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const orgMembersRef = useRef(orgMembers);
  orgMembersRef.current = orgMembers;

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
    // Read latest values via refs — safe because refresh is always called from
    // an effect that was scheduled after these refs were updated.
    const projects = projectsRef.current;
    const orgMembers = orgMembersRef.current;
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
          cells.get(m.userId)!.set(project.id, { role: m.role, secondarySources: m.secondarySources ?? [] });

          if (m.role.level >= 700) ownerCount++;
        }
        ownerCountByProject.set(project.id, ownerCount);
      }

      // Union org members in as rows. Anyone in the org but not yet
      // observed via a project's effective-members list is still on the
      // operator's payroll — they should appear in the matrix with empty
      // cells, distinct from "this person isn't in your org at all."
      // isOrgInherited stays true because their access on any project
      // would come from the org tier (or be absent if the project's
      // org_id is null).
      for (const om of orgMembers) {
        if (!memberByUserId.has(om.userId)) {
          memberByUserId.set(om.userId, {
            userId: om.userId,
            username: om.username,
            isOrgInherited: true,
          });
        }
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, projectsKey, orgMembersKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { matrix, isLoading, error, refresh };
}
