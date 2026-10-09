/**
 * AQU-1566: which existing tracks the caption dialog may overwrite. Once the
 * file has rows, its own Source text and Target text rows (the derived tracks,
 * which have no content file of their own) ARE the file's text: overwriting one
 * re-pointed the timeline at a hidden file, so the timeline and the Text view
 * disagreed. Caption tracks someone added keep their place. The Align script
 * dialog is a different job and keeps its list.
 */
export function captionTrackDestinations<T extends { contentFileId?: string }>(
  tracks: readonly T[], fileHasRows: boolean,
): T[] {
  return fileHasRows ? tracks.filter(track => Boolean(track.contentFileId)) : [...tracks]
}
