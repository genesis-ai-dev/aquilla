// Browser adapter: turn a user's file selection into ProjectEntry[] for the
// Paratext detector. Kept separate from parsers/paratext-project.ts (which is
// pure + node-testable) because this touches the File API + JSZip.

import type { ProjectEntry } from "../parsers/paratext-project"

type FileWithPath = File & { webkitRelativePath?: string }

/**
 * Convert a file selection into project entries:
 *  - a single .zip → expand its members (a zipped Paratext project)
 *  - a folder selection (webkitdirectory) or multi-select → each file, keyed
 *    by its relative path so nested Settings.xml/BookNames.xml are found.
 */
export async function filesToProjectEntries(files: File[]): Promise<ProjectEntry[]> {
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    const JSZip = (await import("jszip")).default
    const zip = await JSZip.loadAsync(await files[0].arrayBuffer())
    const entries: ProjectEntry[] = []
    zip.forEach((path, entry) => {
      if (entry.dir) return
      entries.push({ name: path, text: () => entry.async("string") })
    })
    return entries
  }
  return files.map((f) => ({
    name: (f as FileWithPath).webkitRelativePath || f.name,
    text: () => f.text(),
  }))
}
