/** Date-only formatter shared by the admin tables. "—" for null/unparseable. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString()
}
