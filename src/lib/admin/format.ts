import { fmtShortCalendarDate } from "@/lib/format-date"

/** Date-only formatter shared by the admin tables. "—" for null/unparseable. */
export function fmtDate(iso: string | null | undefined): string {
  return fmtShortCalendarDate(iso)
}
