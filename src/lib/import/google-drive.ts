// Pure logic for the Google Drive importer: routing picked items to
// download/export/skip, recursive folder expansion, and byte fetching.
// The DOM/popup layer (GIS + Picker) lives in google-drive-picker.ts so this
// module stays unit-testable. Loud-drop invariant: planDriveImport places
// every input in either `accepted` or `skipped` — nothing vanishes.

import { detectFileType } from "@/lib/parsers/types"

export interface DrivePickedItem {
  id: string
  name: string
  mimeType: string
}

export interface DriveDownloadTask {
  id: string
  name: string
  mimeType: string
  action: "download" | "export-docx"
}

export interface DriveSkip {
  name: string
  reason: string
}

export interface DriveImportPlan {
  accepted: DriveDownloadTask[]
  skipped: DriveSkip[]
}

/** Provenance stamped into files.meta.aquillaImport.origin — the hook a
 *  future linked-sync mode needs to find the upstream Drive doc. */
export interface DriveOrigin {
  provider: "google-drive"
  driveFileId: string
  mimeType: string
  exportedAs?: "docx"
}

/** The Picker "app ID" is the Cloud project number — the leading digit run of
 *  an OAuth client ID (`123456789-abc.apps.googleusercontent.com`). With the
 *  drive.file scope the Picker must carry it (setAppId), or picking never
 *  grants the app access and every follow-up Drive fetch 404s. */
export function googleAppIdFromClientId(clientId: string): string | null {
  return /^(\d+)-/.exec(clientId)?.[1] ?? null
}

export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder"
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document"
const GOOGLE_NATIVE_PREFIX = "application/vnd.google-apps."
const DOCX_EXPORT_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/** Hard cap on total files after folder expansion. Exceeding it throws —
 *  never truncate silently. */
export const MAX_DRIVE_IMPORT_FILES = 500

const NATIVE_SKIP_REASONS: Record<string, string> = {
  "application/vnd.google-apps.spreadsheet":
    "Google Sheets aren't supported yet — download as .xlsx and upload it instead.",
  "application/vnd.google-apps.presentation":
    "Google Slides aren't supported yet — download as .pptx and upload it instead.",
}

export function planDriveImport(items: DrivePickedItem[]): DriveImportPlan {
  const accepted: DriveDownloadTask[] = []
  const skipped: DriveSkip[] = []
  for (const it of items) {
    if (it.mimeType === GOOGLE_DOC_MIME) {
      const name = /\.docx$/i.test(it.name) ? it.name : `${it.name}.docx`
      accepted.push({ id: it.id, name, mimeType: it.mimeType, action: "export-docx" })
      continue
    }
    if (it.mimeType.startsWith(GOOGLE_NATIVE_PREFIX)) {
      skipped.push({
        name: it.name,
        reason: NATIVE_SKIP_REASONS[it.mimeType] ?? "This Google file type can't be imported.",
      })
      continue
    }
    if (detectFileType(it.name) === null) {
      const ext = /\.[^.]+$/.exec(it.name)?.[0]?.toLowerCase()
      skipped.push({
        name: it.name,
        reason: ext ? `Unsupported file type (${ext}).` : "Unsupported file type.",
      })
      continue
    }
    accepted.push({ id: it.id, name: it.name, mimeType: it.mimeType, action: "download" })
  }
  return { accepted, skipped }
}

export type DriveListPage = { files: DrivePickedItem[]; nextPageToken?: string }

/** Breadth-first expansion of picked folders into their files. `listChildren`
 *  is injected so tests (and the picker layer) own the HTTP call. */
export async function expandDriveFolders(
  items: DrivePickedItem[],
  listChildren: (folderId: string, pageToken?: string) => Promise<DriveListPage>,
): Promise<DrivePickedItem[]> {
  const files: DrivePickedItem[] = []
  const queue: string[] = []
  for (const it of items) {
    if (it.mimeType === GOOGLE_FOLDER_MIME) queue.push(it.id)
    else files.push(it)
  }
  while (queue.length > 0) {
    const folderId = queue.shift() as string
    let pageToken: string | undefined
    do {
      const page = await listChildren(folderId, pageToken)
      for (const child of page.files) {
        if (child.mimeType === GOOGLE_FOLDER_MIME) queue.push(child.id)
        else files.push(child)
      }
      if (files.length > MAX_DRIVE_IMPORT_FILES) {
        throw new Error(
          `That selection contains more than ${MAX_DRIVE_IMPORT_FILES} files. ` +
            "Pick a smaller folder or select files directly.",
        )
      }
      pageToken = page.nextPageToken
    } while (pageToken)
  }
  return files
}

export async function fetchDriveFile(
  task: DriveDownloadTask,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<File> {
  const url =
    task.action === "export-docx"
      ? `https://www.googleapis.com/drive/v3/files/${task.id}/export?mimeType=${encodeURIComponent(DOCX_EXPORT_MIME)}`
      : `https://www.googleapis.com/drive/v3/files/${task.id}?alt=media`
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) {
    throw new Error(
      `Google Drive ${task.action === "export-docx" ? "export" : "download"} failed for ` +
        `${task.name} (HTTP ${res.status}).`,
    )
  }
  const blob = await res.blob()
  return new File([blob], task.name)
}

export function driveOrigin(task: DriveDownloadTask): DriveOrigin {
  return {
    provider: "google-drive",
    driveFileId: task.id,
    mimeType: task.mimeType,
    ...(task.action === "export-docx" ? { exportedAs: "docx" as const } : {}),
  }
}
