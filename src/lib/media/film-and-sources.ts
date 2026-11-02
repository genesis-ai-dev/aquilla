// AQU-1758 (Sam's decision 7): the media view's FILM button (Link video) and
// the timeline's SOURCES menu (audio cues and lines, character sheets,
// subtitles) are dubbing tools. They come and go together, behind one project
// setting in the timeline's settings, beside track editing.
//
// Unset, a project made of books and documents (every file in reading order)
// starts with them hidden, and any other project with them shown. A
// maintainer can change it. It only shows or hides controls — it is not a
// permission, so nothing on the server reads it.

import { fileOrderedBy, type OrderedBy } from "@/lib/parsers/types"

/** A project whose files are all in reading order: Bible books, documents. */
export function isBookProject(files: readonly { orderedBy?: OrderedBy }[] | null | undefined): boolean {
  if (!files || files.length === 0) return false
  return files.every((file) => fileOrderedBy(file) !== "time")
}

/** Whether the Film button and the Sources menu show: the project's own
 *  choice, else off for a book project and on for any other. */
export function filmAndSourcesShown(
  setting: boolean | null | undefined,
  files: readonly { orderedBy?: OrderedBy }[] | null | undefined,
): boolean {
  if (typeof setting === "boolean") return setting
  return !isBookProject(files)
}
