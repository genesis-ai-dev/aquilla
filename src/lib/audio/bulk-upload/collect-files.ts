// AQU-981: the files a person chose, with where each sits in its folder.
//
// A folder picker (<input webkitdirectory>) hands back every file with its
// `webkitRelativePath`. A DROPPED folder arrives as one opaque entry in
// `dataTransfer.files`, so its contents have to be walked through the
// FileSystem entries API. Either way the result is the same list, in folder
// order — the browser's own order is arbitrary (OS-dependent for a picker,
// directory-read order for a drop), so it is never used.

import { compareFolderOrder } from "./match"

export interface ChosenFile {
  file: File
  /** Path inside the chosen folder ("Genesis/Genesis 1-1.mp3"), or the name. */
  path: string
}

type FileWithPath = File & { webkitRelativePath?: string }

/** Folder order: natural order of each file's path. */
export function inFolderOrder(list: ChosenFile[]): ChosenFile[] {
  return [...list].sort((a, b) => compareFolderOrder(a.path, b.path))
}

/** From an <input type="file">, with or without `webkitdirectory`. */
export function chosenFromInput(files: FileList | readonly File[]): ChosenFile[] {
  return inFolderOrder(Array.from(files).map((file) => ({ file, path: (file as FileWithPath).webkitRelativePath || file.name })))
}

interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  fullPath: string
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void
  createReader?: () => { readEntries: (ok: (entries: EntryLike[]) => void, err: (e: unknown) => void) => void }
}

async function walk(entry: EntryLike, out: ChosenFile[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject))
    out.push({ file, path: entry.fullPath.replace(/^\/+/, "") || file.name })
    return
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader()
    // readEntries answers in batches (100 in Chromium) until it returns none.
    for (;;) {
      const batch = await new Promise<EntryLike[]>((resolve, reject) => reader.readEntries(resolve, reject))
      if (batch.length === 0) break
      for (const child of batch) await walk(child, out)
    }
  }
}

/** From a drop: files and whole folders, walked. */
export async function chosenFromDrop(data: DataTransfer): Promise<ChosenFile[]> {
  const entries: EntryLike[] = []
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => EntryLike | null }).webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }
  if (entries.length === 0) return chosenFromInput(data.files)
  const out: ChosenFile[] = []
  for (const entry of entries) await walk(entry, out)
  return inFolderOrder(out)
}
