// Canonical JSON + SHA-256 digest for changeset content addressing.
//
// The digest binds a changeset's commands + preconditions so an ask-mode
// approval assertion can prove which exact plan a human saw. Canonicalization
// (recursively sorted object keys, arrays preserved) makes the digest stable
// across key-ordering differences in the source objects.

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key]
      if (v === undefined) continue
      out[key] = canonicalize(v)
    }
    return out
  }
  return value
}

/** Deterministic JSON string with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** SHA-256 hex digest of `input` (UTF-8). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** digest = SHA-256 over canonical JSON of { commands, preconditions }. */
export async function computeDigest(
  commands: unknown,
  preconditions: unknown,
): Promise<string> {
  return sha256Hex(canonicalJson({ commands, preconditions }))
}
