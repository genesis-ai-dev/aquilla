import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchAccessibleProjectsResult,
  projectsResultError,
  type CloudProjectSummary,
} from "@/lib/sync/cloud-projects";
import { useFrontierSession } from "./useFrontierSession";
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry";
import { toUserFacingError } from "@/lib/errors/user-error";

/**
 * Server-side projects where the current caller holds maintainer (600)+.
 * Used by the multi-project invite flow on the Members page — only projects
 * where the caller can actually grant membership are shown.
 *
 * AQU-321: scoped to minRole=600 (maintainer) so the picker doesn't enumerate
 * every project on the instance. The server enforces the same threshold.
 *
 * Failures stay distinct from a genuinely empty list. In particular, 401
 * raises credential-scoped re-auth rather than making the picker look empty.
 */
export interface UseAccessibleProjects {
  projects: CloudProjectSummary[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAccessibleProjects(): UseAccessibleProjects {
  const { session } = useFrontierSession();
  const jwt = session?.jwt ?? null;
  const [projects, setProjects] = useState<CloudProjectSummary[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const requestRef = useRef(0);
  const jwtRef = useRef(jwt);
  jwtRef.current = jwt;

  // Reset aliveRef on each effect run — see useOrg for the StrictMode
  // rationale (cleanup-only would permanently flip it false in dev).
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    if (!jwt) {
      if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) {
        setProjects([]);
        setError(null);
        setLoading(false);
      }
      return;
    }
    setLoading(true);
    try {
      // AQU-321: only fetch projects where caller >= maintainer (600)
      const result = await fetchAccessibleProjectsResult(jwt, undefined, undefined, 600);
      if (!result.ok) {
        if (result.reason === "unauthenticated") void notifySessionExpiredIfCurrent(jwt);
        throw projectsResultError(result);
      }
      if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) {
        setProjects(result.projects);
        setError(null);
      }
    } catch (caught) {
      if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) {
        setProjects([]);
        setError(toUserFacingError(caught, "project").message);
      }
    } finally {
      if (aliveRef.current && requestRef.current === request && jwtRef.current === jwt) setLoading(false);
    }
  }, [jwt]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { projects, isLoading, error, refresh };
}

/**
 * AQU-428: All projects the current user can access (viewer 100+), including
 * projects where the user has a direct project_members grant but is NOT a
 * member of the project's org.
 *
 * Used for navigation listing (Dashboard / "Shared with you") so project-only
 * invitees can discover their projects without needing org membership.
 *
 * Unlike `useAccessibleProjects` (minRole=600, invite picker only), this hook
 * fetches with no minRole filter so viewers and contributors appear too.
 */
export function useProjectsForNavigation(enabled = true): UseAccessibleProjects {
  const { session } = useFrontierSession();
  const jwt = session?.jwt ?? null;
  const [projects, setProjects] = useState<CloudProjectSummary[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const requestRef = useRef(0);
  const scopeRef = useRef({ enabled, jwt });
  scopeRef.current = { enabled, jwt };

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    if (!enabled) {
      if (aliveRef.current && scopeRef.current.enabled === enabled && scopeRef.current.jwt === jwt) {
        setProjects([]);
        setError(null);
        setLoading(false);
      }
      return;
    }
    if (!jwt) {
      if (aliveRef.current && requestRef.current === request && scopeRef.current.enabled === enabled && scopeRef.current.jwt === jwt) {
        setProjects([]);
        setError(null);
        setLoading(false);
      }
      return;
    }
    setLoading(true);
    try {
      // No minRole — include every project the caller can access (viewer+),
      // including direct project_members grants with no org-level membership.
      const result = await fetchAccessibleProjectsResult(jwt);
      if (!result.ok) {
        if (result.reason === "unauthenticated") void notifySessionExpiredIfCurrent(jwt);
        throw projectsResultError(result);
      }
      if (aliveRef.current && requestRef.current === request && scopeRef.current.enabled === enabled && scopeRef.current.jwt === jwt) {
        setProjects(result.projects);
        setError(null);
      }
    } catch (caught) {
      if (aliveRef.current && requestRef.current === request && scopeRef.current.enabled === enabled && scopeRef.current.jwt === jwt) {
        setProjects([]);
        setError(toUserFacingError(caught, "project").message);
      }
    } finally {
      if (aliveRef.current && requestRef.current === request && scopeRef.current.enabled === enabled && scopeRef.current.jwt === jwt) setLoading(false);
    }
  }, [enabled, jwt]);

  useEffect(() => { void refresh(); }, [refresh]);

  return { projects, isLoading, error, refresh };
}
