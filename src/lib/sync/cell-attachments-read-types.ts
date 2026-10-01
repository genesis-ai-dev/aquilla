// Mirror of sync-worker/src/events/cell-attachments-read-route.ts
// AttachmentRowOut. AQU-777.

export interface CellAttachmentRecord {
  attachmentId: string
  projectId: string
  fileId: string
  cellId: string
  /** R2 object name inside the cell's file scope ("<attachmentId>.<ext>"). */
  objectName: string
  /** The user-visible file name, as picked. */
  name: string
  mimeType: string | null
  sizeBytes: number | null
  authorId: string
  authorLabel: string | null
  createdAt: number
  /** The source cell's canonical reference ("GEN 1:1"); null when the cell has
   *  none or no longer exists. */
  cellRef: string | null
}

export interface CellAttachmentsResponse {
  attachments: CellAttachmentRecord[]
  /** True when the file has more attachments than the worker's backstop
   *  returns. Surfaced rather than swallowed so a drawer showing a partial
   *  list can say so. */
  truncated?: boolean
}
