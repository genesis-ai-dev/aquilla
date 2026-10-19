/** App string keys a source uses (literal t("…") calls), minus the SDK's own
 *  English-only "sdk." keys. Kept apart from sdk.ts so a caller (the
 *  first-party editor, bundled into the auth-worker) does not pull the SDK
 *  source in with it. */
export function stringKeysOf(source: string): string[] {
  return [...new Set([...source.matchAll(/\bt\("([A-Za-z0-9_.]+)"/g)].map((m) => m[1]).filter((k) => !k.startsWith("sdk.")))].sort()
}
