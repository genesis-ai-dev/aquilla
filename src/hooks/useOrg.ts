import { useCallback, useEffect, useRef, useState } from "react";
import {
  getOrCreateMyOrg, listOrgMembers, addOrgMember, removeOrgMember,
  listOrgMemberProjects, type MyOrg, type OrgMember, type OrgMemberProject,
} from "@/lib/frontier/orgs";
import { useFrontierSession } from "./useFrontierSession";

export function useOrg() {
  const { session } = useFrontierSession();
  const jwt = session?.jwt ?? null;
  const [org, setOrg] = useState<MyOrg | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => () => { aliveRef.current = false; }, []);

  useEffect(() => {
    if (!jwt) {
      setOrg(null);
      return;
    }
    let cancelled = false;
    getOrCreateMyOrg(jwt)
      .then((o) => { if (!cancelled && aliveRef.current) setOrg(o); })
      .catch((e) => { if (!cancelled && aliveRef.current) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [jwt]);

  return { org, error };
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

  useEffect(() => () => { aliveRef.current = false; }, []);

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
