// Decode server-issued claims for browser scoping, never for server authorization.
export function sessionClaims(token: string): { sub?: string; email?: string; uid?: string } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return {};
    // atob requires standard base64; JWT uses base64url — swap - and _
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    const payload = JSON.parse(json) as { sub?: unknown; email?: unknown; uid?: unknown };
    return {
      uid: typeof payload.uid === "string" && /^[1-9][0-9]*$/.test(payload.uid) ? payload.uid : undefined,
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
  } catch {
    return {};
  }
}
