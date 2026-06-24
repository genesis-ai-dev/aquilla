import { useEffect, useRef, useState } from "react";
import { fetchAccessibleProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects";
import { useFrontierSession } from "./useFrontierSession";

/**
 * Server-side projects where the current caller holds maintainer (600)+.
 * Used by the multi-project invite flow on the Members page — only projects
 * where the caller can actually grant membership are shown.
 *
 * FRO-321: scoped to minRole=600 (maintainer) so the picker doesn't enumerate
 * every project on the instance. The server enforces the same threshold.
 *
 * `fetchAccessibleProjects` already swallows network errors and returns []
 * on any failure, so this hook never enters an "error" branch — empty list
 * just means "nothing to invite to" or "couldn't reach server."
 */
export interface UseAccessibleProjects {
  projects: CloudProjectSummary[];
  isLoading: boolean;
  refresh: () => Promise<void>;
}

export function useAccessibleProjects(): UseAccessibleProjects {
  const { session } = useFrontierSession();
  const jwt = session?.jwt ?? null;
  const [projects, setProjects] = useState<CloudProjectSummary[]>([]);
  const [isLoading, setLoading] = useState(false);
  const aliveRef = useRef(true);

  // Reset aliveRef on each effect run — see useOrg for the StrictMode
  // rationale (cleanup-only would permanently flip it false in dev).
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const refresh = async () => {
    if (!jwt) {
      if (aliveRef.current) setProjects([]);
      return;
    }
    setLoading(true);
    try {
      // FRO-321: only fetch projects where caller >= maintainer (600)
      const next = await fetchAccessibleProjects(jwt, undefined, undefined, 600);
      if (aliveRef.current) setProjects(next);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [jwt]);

  return { projects, isLoading, refresh };
}

/**
 * FRO-428: All projects the current user can access (viewer 100+), including
 * projects where the user has a direct project_members grant but is NOT a
 * member of the project's org.
 *
 * Used for navigation listing (Dashboard / "Shared with you") so project-only
 * invitees can discover their projects without needing org membership.
 *
 * Unlike `useAccessibleProjects` (minRole=600, invite picker only), this hook
 * fetches with no minRole filter so viewers and contributors appear too.
 */
export function useProjectsForNavigation(): UseAccessibleProjects {
  const { session } = useFrontierSession();
  const jwt = session?.jwt ?? null;
  const [projects, setProjects] = useState<CloudProjectSummary[]>([]);
  const [isLoading, setLoading] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const refresh = async () => {
    if (!jwt) {
      if (aliveRef.current) setProjects([]);
      return;
    }
    setLoading(true);
    try {
      // No minRole — include every project the caller can access (viewer+),
      // including direct project_members grants with no org-level membership.
      const next = await fetchAccessibleProjects(jwt);
      if (aliveRef.current) setProjects(next);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [jwt]);

  return { projects, isLoading, refresh };
}
