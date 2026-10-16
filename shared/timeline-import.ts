/** The SPA and sync worker share this text-track publication payload. */
export interface ImportedTrackPublication {
  contentFileId: string
  trackId: string
  eventId: string
  name: string
  /** Present only after an explicit, counted overwrite confirmation. */
  overwrite?: { contentFileId: string | null; segmentCount: number }
}

/**
 * AQU-1566 (option b): turn a linked video's caption content into the file's
 * own rows. Sent on the parent's empty `/import` completion request.
 *
 * Without `trackId`, `contentFileId` is a freshly staged (hidden, deleted)
 * caption file. With `trackId`, it is the content of a caption track already
 * on the timeline; that track is retired and its file deleted in the same
 * transaction, so `retireEventId` and `deleteEventId` are required with it.
 */
export interface CaptionRowsPromotion {
  /** The hidden timeline-content file holding the cues. */
  contentFileId: string
  /** Present when an attached caption track is being turned into rows. */
  trackId?: string
  /** Client-minted id of the parent's `file.create` re-genesis: the receipt
   *  that makes a retried request safe. */
  genesisEventId: string
  /** `file.track.set { trackId, patch: null }`; required with `trackId`. */
  retireEventId?: string
  /** `file.delete` of the content file; required with `trackId`. */
  deleteEventId?: string
}
