// AQU-1758 (Sam's decision 7): the media view's FILM button (Link video) and
// the timeline's SOURCES menu (audio cues and lines, character sheets,
// subtitles) are dubbing tools. They come and go together, behind one project
// setting in the timeline's settings, beside track editing.
//
// Unset, a project made of books and documents (every file in reading order)
// starts with them hidden, and any other project with them shown. A
// maintainer can change it. It only shows or hides controls — it is not a
// permission, so nothing on the server reads it.
//
// A recording or film uploaded as its own file doesn't make a book project
// something else (import map D#25): one audio or video file used to turn the
// tools on for every book. Such a file is left out of deciding what kind of
// project it is, and shows the tools on itself.

import { fileOrderedBy, type FileType, type OrderedBy } from "@/lib/parsers/types"

interface FileKind { orderedBy?: OrderedBy; type?: FileType }

/** A recording or film imported as its own file. */
function isMediaFile(file: FileKind): boolean {
  return file.type === "audio" || file.type === "video"
}

/** A project whose files are all in reading order: Bible books, documents.
 *  Recordings and films uploaded as their own files don't count either way. */
export function isBookProject(files: readonly FileKind[] | null | undefined): boolean {
  const rest = (files ?? []).filter((file) => !isMediaFile(file))
  if (rest.length === 0) return false
  return rest.every((file) => fileOrderedBy(file) !== "time")
}

/** Whether the Film button and the Sources menu show: the project's own
 *  choice, else on for a recording or film's own file, off for a book
 *  project and on for any other. */
export function filmAndSourcesShown(
  setting: boolean | null | undefined,
  files: readonly FileKind[] | null | undefined,
  file?: FileKind | null,
): boolean {
  if (typeof setting === "boolean") return setting
  if (file && isMediaFile(file)) return true
  return !isBookProject(files)
}
