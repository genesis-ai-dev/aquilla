// AQU-2265: the temporary "This setting moved" notes left where a setting
// used to live (Sam, Oct 29). One date ends every one of them; there is no
// per-person dismissal (Sam: "all of them should stop showing at the end of
// November").
//
// TO REMOVE THE NOTES LATER: delete this file and
// src/components/settings/SettingMovedNote.tsx, then fix the compile errors —
// each one is a one-line note to delete. The highlight a note's link asks for
// (`?highlight=`) is a separate, general piece (useSettingHighlight) and can
// stay.

/** The LAST day the notes show, in the reader's own time zone. */
export const SETTING_MOVED_NOTES_UNTIL = "2026-11-30"

/** Are the "this setting moved" notes still showing? */
export function settingMovedNotesShowing(now: Date = new Date()): boolean {
  const [year, month, day] = SETTING_MOVED_NOTES_UNTIL.split("-").map(Number)
  // Local midnight after the last day.
  return now.getTime() < new Date(year, month - 1, day + 1).getTime()
}
