// AQU-2139: the two glyphs that tell text work from audio work, shared by
// every surface that marks those two columns.
//
// The chapter picker's progress lines (`ChapterNavigator`) and the editing
// table's header marks (`table-header-marks`) each label a text column and an
// audio column. They were drawn a fortnight apart and picked different glyphs
// — a "T" and a sound wave in the header, the translation glyph and a
// microphone in the picker — so one screen carried two icon vocabularies for
// the same two things. Both read from here now.
//
// The double check that marks VALIDATED is drawn over both columns, so it
// distinguishes nothing and is not part of this pair.

import { Languages, Mic, type LucideIcon } from "lucide-react"

export const PROGRESS_ICON = {
  /** Text work: the glyph on the picker's "N% translated" line. */
  text: Languages,
  /** Audio work: the glyph on the picker's "N% recorded" line. */
  audio: Mic,
} as const satisfies Record<"text" | "audio", LucideIcon>
