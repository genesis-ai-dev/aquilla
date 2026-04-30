import { useCallback, useEffect, useRef, useState } from "react";
import {
  getOrCreateMyOrg, listOrgMembers, addOrgMember, removeOrgMember,
  listOrgMemberProjects, type MyOrg, type OrgMember, type OrgMemberProject,
} from "@/lib/frontier/orgs";
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
  refresh: () => Promise<void>;
  add: (username: string, role: number) => Promise<OrgMember | null>;
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
      const next = await listOrgMembers(jwt, orgId);
      if (aliveRef.current) setMembers(next);
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

  const remove = useCallback(async (userId: number) => {
    if (!jwt || orgId == null) return;
    await removeOrgMember(jwt, orgId, userId);
    await refresh();
  }, [jwt, orgId, refresh]);

  const listMemberProjects = useCallback(async (userId: number) => {
    if (!jwt || orgId == null) return [];
    return listOrgMemberProjects(jwt, orgId, userId);
  }, [jwt, orgId]);

  return { members, isLoading, error, refresh, add, remove, listMemberProjects };
}
