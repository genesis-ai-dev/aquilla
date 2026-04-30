import { useCallback, useEffect, useRef, useState } from "react";
import {
  listProjectMembers, addProjectMember, removeProjectMember,
  lookupUser,
  type ProjectMember,
} from "@/lib/frontier/members";
import { useFrontierSession } from "./useFrontierSession";

export interface UseProjectMembers {
  members: ProjectMember[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Returns null if username not found, otherwise the new/upserted member. */
  add: (username: string, role: number) => Promise<ProjectMember | null>;
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
  const aliveRef = useRef(true);

  useEffect(() => () => { aliveRef.current = false; }, []);

  const refresh = useCallback(async () => {
    if (!jwt || !projectId) return;
    setLoading(true);
    setError(null);
    try {
      // null = caller has no server-side access OR project doesn't exist
      // server-side. Both are expected for local-only IndexedDB projects;
      // we render an empty members list and don't surface as an error.
      const next = await listProjectMembers(jwt, projectId);
      if (aliveRef.current) setMembers(next ?? []);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
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

  const remove = useCallback(async (userId: number) => {
    if (!jwt || !projectId) return;
    await removeProjectMember(jwt, projectId, userId);
    await refresh();
  }, [jwt, projectId, refresh]);

  return { members, isLoading, error, refresh, add, remove, changeRole: add };
}
