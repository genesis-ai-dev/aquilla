/** The SPA and sync worker share this text-track publication payload. */
export interface ImportedTrackPublication {
  contentFileId: string
  trackId: string
  eventId: string
  name: string
  /** Present only after an explicit, counted overwrite confirmation. */
  overwrite?: { contentFileId: string | null; segmentCount: number }
}
