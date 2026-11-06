// Paratext's "Register" link carries one token: a Base64 (no `=` padding) of a
// percent-encoded query string. Aquilla can build it from Settings.xml and the
// local RegistrationInfo.xml, so a user never has to copy it by hand.
//
// Decoded sample from a real project:
//   sn=TPP1&fn=Test%20Paratext%20Project%201&id=6b5b…2d3d&l=en&un=Ryder%20Wishart&t=Standard&p=
//
// Still to confirm against Paratext itself (see the plan's open items): the
// base URL, standard vs URL-safe alphabet, and the exact `p` for daughter
// projects. `decodeRegistrationToken` accepts both alphabets.

export interface RegistrationFields {
  /** Project short name — Settings.xml <Name>. */
  sn: string
  /** Project full name — Settings.xml <FullName>. */
  fn: string
  /** Project GUID — Settings.xml <Guid>, 40 hex. */
  id: string
  /** Language code — Settings.xml <LanguageIsoCode> before the first colon. */
  l: string
  /** Registered Paratext user name — RegistrationInfo.xml <Name>. */
  un: string
  /** Project type — Settings.xml <TranslationInfo> before the first `::`. */
  t: string
  /** Parent project for daughter types (back translation…), else empty. */
  p?: string
}

const ORDER = ["sn", "fn", "id", "l", "un", "t", "p"] as const

export function encodeRegistrationToken(f: RegistrationFields): string {
  const query = ORDER.map((k) => `${k}=${encodeURIComponent(f[k] ?? "")}`).join("&")
  const bytes = new TextEncoder().encode(query)
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/=+$/, "")
}

export function decodeRegistrationToken(token: string): Partial<RegistrationFields> {
  const std = token.replace(/-/g, "+").replace(/_/g, "/")
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4)
  const bin = atob(padded)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  const query = new TextDecoder().decode(bytes)
  const out: Partial<RegistrationFields> = {}
  for (const [k, v] of new URLSearchParams(query)) {
    if ((ORDER as readonly string[]).includes(k)) out[k as keyof RegistrationFields] = v
  }
  return out
}

/** Settings.xml <TranslationInfo> is `Type::Parent::…` — e.g. `Standard::` or
 *  `BackTranslation:TPP1:…`. Returns the type and the parent short name. */
export function parseTranslationInfo(info: string): { type: string; parent: string } {
  const parts = info.split(":")
  return { type: parts[0] ?? "", parent: parts.find((p, i) => i > 0 && p.length > 0) ?? "" }
}
