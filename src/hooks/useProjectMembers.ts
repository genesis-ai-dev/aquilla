import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchProjectRoster, addProjectMember, addProjectMembers, removeProjectMember,
  lookupUser,
  type ProjectMember, type MemberGrantResult,
} from "@/lib/frontier/members";
import { useFrontierSession } from "./useFrontierSession";
import { toUserFacingError } from "@/lib/errors/user-error";

export interface UseProjectMembers {
  members: ProjectMember[];
  isLoading: boolean;
  error: string | null;
  /**
   * AQU-485: true when the project's org rosterViewMinRole policy hides the
   * roster from the caller — distinct from "no access" / "genuinely empty."
   * Callers should render an explicit "hidden by org policy" state rather
   * than an empty members list (which implies zero members).
   */
  rosterHidden: boolean;
  refresh: () => Promise<void>;
  /** Returns null if username not found, otherwise the new/upserted member. */
  add: (username: string, role: number) => Promise<ProjectMember | null>;
  /**
   * AQU-734: grant `role` to several people in ONE batch request (non-atomic).
   * Returns the per-person `results` so the caller can name who failed. The
   * roster is refreshed once after the call so everyone who landed shows up.
   */
  addMany: (
    members: Array<{ username: string; role: number }>,
  ) => Promise<MemberGrantResult[]>;
  remove: (userId: number) => Promise<void>;
  /** Same as add — server upserts. Convenience for renaming the call site. */
  changeRole: (username: string, role: number) => Promise<ProjectMember | null>;
}

export function useProjectMembers(projectId: string | null): UseProjectMembers {
  const { session } = useFrontierSession();
  const jwt = session?.jwt ?? null;
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rosterHidden, setRosterHidden] = useState(false);
  const aliveRef = useRef(true);

  // Reset aliveRef on each effect run so React StrictMode's dry-run
  // cleanup doesn't permanently flip it false (which would cause every
  // subsequent setState in this hook to be silently skipped — the
  // "Loading… spins forever" failure mode).
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!jwt || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchProjectRoster(jwt, projectId);
      if (!aliveRef.current) return;
      if (result.kind === "ok") {
        setMembers(result.members);
        setRosterHidden(false);
      } else if (result.kind === "roster-hidden") {
        setMembers([]);
        setRosterHidden(true);
      } else {
        // no-access: caller has no server-side access OR project doesn't
        // exist server-side (both expected for local-only IndexedDB
        // projects) — render an empty list, no error, same as pre-AQU-485.
        setMembers([]);
        setRosterHidden(false);
      }
    } catch (e) {
      if (aliveRef.current) setError(toUserFacingError(e, "project").message);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [jwt, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const add = useCallback(async (username: string, role: number) => {
    if (!jwt || !projectId) return null;
    const found = await lookupUser(jwt, username);
    if (!found) return null;
    const next = await addProjectMember(jwt, projectId, username, role);
    await refresh();
    return next;
  }, [jwt, projectId, refresh]);

  const addMany = useCallback(async (
    toAdd: Array<{ username: string; role: number }>,
  ) => {
    if (!jwt || !projectId || toAdd.length === 0) return [];
    const results = await addProjectMembers(jwt, projectId, toAdd);
    await refresh();
    return results;
  }, [jwt, projectId, refresh]);

  const remove = useCallback(async (userId: number) => {
    if (!jwt || !projectId) return;
    await removeProjectMember(jwt, projectId, userId);
    await refresh();
  }, [jwt, projectId, refresh]);

  return { members, isLoading, error, rosterHidden, refresh, add, addMany, remove, changeRole: add };
}
