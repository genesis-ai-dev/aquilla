// The three Drive v3 calls the folder sync makes: read the folder, list its
// files, fetch one file's bytes. Google Docs are exported as .docx so both a
// Word upload and a native Doc go through the same DOCX walk.

const DRIVE_API = 'https://www.googleapis.com/drive/v3'
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'
export const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document'
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  /** Drive's monotonically increasing version: moves on every content change
   *  (and on some metadata changes, which the sha256 check then absorbs). */
  version: string
}

/** True for the files the sync turns into Aquilla files. */
export function isSyncableDriveFile(file: Pick<DriveFile, 'mimeType'>): boolean {
  return file.mimeType === GOOGLE_DOC_MIME || file.mimeType === DOCX_MIME
}

/** Drive file name → Aquilla file name. A Google Doc has no extension. */
export function aquillaFileName(file: Pick<DriveFile, 'name' | 'mimeType'>): string {
  if (file.mimeType === GOOGLE_DOC_MIME && !/\.docx$/i.test(file.name)) return `${file.name}.docx`
  return file.name
}

async function driveFetch(token: string, url: string, fetchFn: typeof fetch): Promise<Response> {
  const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const hint = response.status === 404 ? ' (is the folder shared with the service account?)' : ''
    throw new Error(`Drive request failed (HTTP ${response.status})${hint}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  return response
}

/** The folder's name. Throws when the id is not a folder the account can see. */
export async function getDriveFolder(token: string, folderId: string, fetchFn: typeof fetch = fetch): Promise<{ id: string; name: string }> {
  const url = `${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType&supportsAllDrives=true`
  const body = (await (await driveFetch(token, url, fetchFn)).json()) as { id: string; name: string; mimeType: string }
  if (body.mimeType !== DRIVE_FOLDER_MIME) throw new Error(`Drive item ${folderId} is not a folder`)
  return { id: body.id, name: body.name }
}

/** Every non-trashed direct child of the folder (no recursion into subfolders). */
export async function listDriveFolder(token: string, folderId: string, fetchFn: typeof fetch = fetch): Promise<DriveFile[]> {
  const files: DriveFile[] = []
  let pageToken: string | undefined
  do {
    const params = new URLSearchParams({
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      fields: 'nextPageToken,files(id,name,mimeType,version)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {}),
    })
    const body = (await (await driveFetch(token, `${DRIVE_API}/files?${params}`, fetchFn)).json()) as {
      files?: DriveFile[]
      nextPageToken?: string
    }
    files.push(...(body.files ?? []))
    pageToken = body.nextPageToken
  } while (pageToken)
  return files
}

/** The file's bytes as .docx (a Google Doc is exported). */
export async function downloadDriveFileAsDocx(token: string, file: DriveFile, fetchFn: typeof fetch = fetch): Promise<Uint8Array> {
  const id = encodeURIComponent(file.id)
  const url = file.mimeType === GOOGLE_DOC_MIME
    ? `${DRIVE_API}/files/${id}/export?mimeType=${encodeURIComponent(DOCX_MIME)}`
    : `${DRIVE_API}/files/${id}?alt=media&supportsAllDrives=true`
  return new Uint8Array(await (await driveFetch(token, url, fetchFn)).arrayBuffer())
}

/** A folder id from a pasted Drive URL or a bare id. Null when neither. */
export function driveFolderIdFromInput(input: string): string | null {
  const trimmed = input.trim()
  const fromUrl = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(trimmed)?.[1] ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(trimmed)?.[1]
  if (fromUrl) return fromUrl
  return /^[A-Za-z0-9_-]{10,}$/.test(trimmed) ? trimmed : null
}
