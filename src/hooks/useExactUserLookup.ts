import { useEffect, useRef, useState } from "react"
import { lookupUser, type LookedUpUser } from "@/lib/frontier/members"
import { useFrontierSession } from "./useFrontierSession"

export type ExactLookupStatus =
  | "idle"
  | "checking"
  | "found"
  | "notfound"
  | "error"

export interface UseExactUserLookup {
  status: ExactLookupStatus
  /** The resolved account when `status === "found"`, else null. */
  user: LookedUpUser | null
  /** The exact (trimmed) username this result describes — compare against the
   * current input to know whether the result is still for what's typed. */
  forUsername: string
}

/**
 * AQU-781: exact, UNSCOPED username resolution for the add-member typeahead.
 *
 * The scoped prefix search (`useUserSearch`) only surfaces people who already
 * share an org/project with the caller (AQU-321), so a scoped miss is NOT proof
 * the account doesn't exist. When `enabled`, this resolves the exact typed
 * username against `GET /api/v2/users/lookup` (auth-gated, exact match, not
 * scope-restricted) so the dropdown can distinguish "exists but out of your
 * visibility scope" from "truly no such user" — instead of falsely asserting
 * the account doesn't exist and steering the operator away.
 *
 * Pass `enabled=false` (e.g. while the scoped search is still running, has
 * hits, or the input is too short) to skip the round-trip entirely. This keeps
 * the scoped dropdown's enumeration surface unchanged (AQU-321/AQU-625): the
 * lookup is exact-match only and fires solely on a settled scoped miss.
 */
export function useExactUserLookup(
  username: string,
  enabled: boolean,
): UseExactUserLookup {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const trimmed = username.trim()
  const [state, setState] = useState<UseExactUserLookup>({
    status: "idle",
    user: null,
    forUsername: "",
  })
  const seqRef = useRef(0)

  useEffect(() => {
    if (!enabled || !jwt || trimmed.length === 0) {
      // Not resolving right now — report idle for the empty query so the UI
      // never shows a stale "found/not found" for something not typed.
      setState({ status: "idle", user: null, forUsername: "" })
      return
    }
    const seq = ++seqRef.current
    let alive = true
    setState({ status: "checking", user: null, forUsername: trimmed })
    lookupUser(jwt, trimmed)
      .then((user) => {
        if (!alive || seq !== seqRef.current) return
        setState({
          status: user ? "found" : "notfound",
          user,
          forUsername: trimmed,
        })
      })
      .catch(() => {
        if (!alive || seq !== seqRef.current) return
        // A failed lookup is NOT a "no such user" answer — surface `error` so
        // the UI can offer a submit-time fallback rather than claim non-existence.
        setState({ status: "error", user: null, forUsername: trimmed })
      })
    return () => {
      alive = false
    }
  }, [enabled, jwt, trimmed])

  return state
}
