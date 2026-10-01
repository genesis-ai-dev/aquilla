/**
 * AQU-1352 §3.9 rule 2: a role-gated 403 names the scope, the caller's role,
 * and where that role came from, so the client can say "You are Contributor
 * here (via team). Maintainer is required." instead of a bare "no permission".
 *
 * Additive: `error` keeps its legacy string for older clients and logs.
 */
export interface RoleRequiredBody {
  error: string
  code: "role_required"
  required: { roleLevel: number }
  actual: { roleLevel: number | null; source: string | null; scopePath?: string[] }
}

export function roleRequiredBody(
  error: string,
  requiredLevel: number,
  actual: { level: number; source?: string | null } | null,
  scopePath?: string[],
): RoleRequiredBody {
  return {
    error,
    code: "role_required",
    required: { roleLevel: requiredLevel },
    actual: {
      roleLevel: actual?.level ?? null,
      source: actual?.source ?? null,
      ...(scopePath?.length ? { scopePath } : {}),
    },
  }
}
