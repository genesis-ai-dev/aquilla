import { useCallback, useEffect, useRef, useState } from "react";
import {
  getOrCreateMyOrg, fetchOrgRoster, addOrgMember, addOrgMembers, removeOrgMember,
  listOrgMemberProjects, type MyOrg, type OrgMember, type OrgMemberProject,
} from "@/lib/frontier/orgs";
import type { MemberGrantResult } from "@/lib/frontier/members";
import { useFrontierSession } from "./useFrontierSession";

/**
 * Async resource state. Distinguishes the five cases callers actually care
 * about:
 *   - idle:           signed out / no session
 *   - session-loading: account hydration in flight (no JWT yet)
 *   - loading:        JWT present, /orgs/me fetch in flight
 *   - error:          fetch finished with an error
 *   - success:        fetch finished with data
 *
 * Distinguishing session-loading from org-loading matters for the UX —
 * "Waiting for session…" is a different message than "Loading members…",
 * and conflating them is exactly how the page gets stuck on a misleading
 * "Loading members…" message when the real issue is unrelated.
 */
export type OrgState =
  | { kind: "idle" }
  | { kind: "session-loading" }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "success"; org: MyOrg };

export interface UseOrg {
  state: OrgState;
  /** Convenience accessor — null unless state is "success". */
  org: MyOrg | null;
  /** Convenience accessor — null unless state is "error". */
  error: string | null;
  /** Re-fire the /orgs/me fetch (e.g. after a 401 retry). */
  refresh: () => Promise<void>;
}

export function useOrg(): UseOrg {
  const { session, loading: sessionLoading } = useFrontierSession();
  const jwt = session?.jwt ?? null;
  const [state, setState] = useState<OrgState>({ kind: "idle" });
  const aliveRef = useRef(true);

  // CRITICAL: reset aliveRef to true on every effect run, not just at mount.
  // React StrictMode in dev runs setup → cleanup → setup as a dry-run on
  // first mount. Without the explicit `aliveRef.current = true` here, the
  // first cleanup permanently flips the ref to false, every subsequent
  // setState gets silently skipped, and the page hangs on whatever state
  // the cleanup interrupted (typically "loading"). This was the root cause
  // of the "Loading members… spins forever" symptom.
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!jwt) {
      if (aliveRef.current) {
        setState({ kind: sessionLoading ? "session-loading" : "idle" });
      }
      return;
    }
    if (aliveRef.current) setState({ kind: "loading" });
    try {
      const org = await getOrCreateMyOrg(jwt);
      if (aliveRef.current) setState({ kind: "success", org });
    } catch (e) {
      if (aliveRef.current) {
        setState({ kind: "error", error: e instanceof Error ? e.message : String(e) });
      }
    }
  }, [jwt, sessionLoading]);

  useEffect(() => { void refresh(); }, [refresh]);

  return {
    state,
    org: state.kind === "success" ? state.org : null,
    error: state.kind === "error" ? state.error : null,
    refresh,
  };
}

export interface UseOrgMembers {
  members: OrgMember[];
  isLoading: boolean;
  error: string | null;
  /**
   * AQU-485: true when the org's rosterViewMinRole policy hides the roster
   * from the caller (a distinct condition from a fetch error or genuine
   * "no members"). Callers should render an explicit "hidden by org policy"
   * state, not an empty roster — an empty list implies zero members, which
   * is not what a hidden roster means.
   */
  rosterHidden: boolean;
  refresh: () => Promise<void>;
  add: (username: string, role: number) => Promise<OrgMember | null>;
  /**
   * AQU-734: grant `role` to several people in ONE batch request (non-atomic).
   * Returns the per-person `results` so the caller can name who failed; the
   * roster refreshes once after so everyone who landed shows up.
   */
  addMany: (
    members: Array<{ username: string; role: number }>,
  ) => Promise<MemberGrantResult[]>;
  remove: (userId: number) => Promise<void>;
  /** For the remove-confirmation flow: list a member's direct project memberships. */
  listMemberProjects: (userId: number) => Promise<OrgMemberProject[]>;
}

export function useOrgMembers(orgId: number | null): UseOrgMembers {
  const { session } = useFrontierSession();
  const jwt = session?.jwt ?? null;
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rosterHidden, setRosterHidden] = useState(false);
  const aliveRef = useRef(true);

  // See useOrg above for the StrictMode rationale — same pattern.
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!jwt || orgId == null) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchOrgRoster(jwt, orgId);
      if (!aliveRef.current) return;
      if (result.kind === "ok") {
        setMembers(result.members);
        setRosterHidden(false);
      } else if (result.kind === "roster-hidden") {
        // AQU-485: don't render an empty shell that leaks "zero members" —
        // clear the list AND flag the distinct hidden state so the page can
        // show "Roster hidden by org policy" instead.
        setMembers([]);
        setRosterHidden(true);
      } else {
        // no-access: not an org member. Keep pre-AQU-485 behavior (empty,
        // no error surfaced) — this route already requires org membership
        // to reach this hook in practice.
        setMembers([]);
        setRosterHidden(false);
      }
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [jwt, orgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const add = useCallback(async (username: string, role: number) => {
    if (!jwt || orgId == null) return null;
    try {
      const next = await addOrgMember(jwt, orgId, username, role);
      await refresh();
      return next;
    } catch {
      return null;
    }
  }, [jwt, orgId, refresh]);

  const addMany = useCallback(async (
    toAdd: Array<{ username: string; role: number }>,
  ) => {
    if (!jwt || orgId == null || toAdd.length === 0) return [];
    const results = await addOrgMembers(jwt, orgId, toAdd);
    await refresh();
    return results;
  }, [jwt, orgId, refresh]);

  const remove = useCallback(async (userId: number) => {
    if (!jwt || orgId == null) return;
    await removeOrgMember(jwt, orgId, userId);
    await refresh();
  }, [jwt, orgId, refresh]);

  const listMemberProjects = useCallback(async (userId: number) => {
    if (!jwt || orgId == null) return [];
    return listOrgMemberProjects(jwt, orgId, userId);
  }, [jwt, orgId]);

  return { members, isLoading, error, rosterHidden, refresh, add, addMany, remove, listMemberProjects };
}
