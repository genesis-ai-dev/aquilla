// Browser adapter: turn a user's file selection into ProjectEntry[] for the
// Paratext detector. Kept separate from parsers/paratext-project.ts (which is
// pure + node-testable) because this touches the File API + JSZip.

import type { ProjectEntryCollection } from "../parsers/paratext-project"

type FileWithPath = File & { webkitRelativePath?: string }
const ZIP_EPOCH = new Date("1980-01-01T00:00:00.000Z")

function relativePath(file: FileWithPath): string {
  return file.webkitRelativePath || file.name
}

/**
 * Convert a file selection into project entries:
 *  - a single .zip → expand its members (a zipped Paratext project)
 *  - a folder selection (webkitdirectory) or multi-select → each file, keyed
 *    by its relative path so nested Settings.xml/BookNames.xml are found.
 */
export async function filesToProjectEntries(files: File[]): Promise<ProjectEntryCollection> {
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    const JSZip = (await import("jszip")).default
    const originalBytes = await files[0].arrayBuffer()
    const zip = await JSZip.loadAsync(originalBytes)
    const entries: ProjectEntryCollection = []
    zip.forEach((path, entry) => {
      if (entry.dir) return
      entries.push({
        name: path,
        text: () => entry.async("string"),
        bytes: () => entry.async("arraybuffer"),
      })
    })
    entries.sourceArtifact = {
      name: files[0].name,
      format: "paratext-project",
      bytes: async () => originalBytes,
    }
    return entries
  }
  const entries = files.map((f) => ({
    name: relativePath(f as FileWithPath),
    text: () => f.text(),
    bytes: () => f.arrayBuffer(),
  })) as ProjectEntryCollection
  if (files.length > 1 || files.some((file) => Boolean((file as FileWithPath).webkitRelativePath))) {
    const firstPath = (files[0] as FileWithPath | undefined)?.webkitRelativePath
    const rootName = firstPath?.split("/")[0] || "paratext-project"
    entries.sourceArtifact = {
      name: `${rootName}.zip`,
      format: "paratext-project",
      bytes: async () => {
        const JSZip = (await import("jszip")).default
        const zip = new JSZip()
        // Browser file pickers do not guarantee enumeration order, and JSZip
        // otherwise stamps entries with the current time. Sort paths and use
        // the ZIP epoch so the same folder produces the same checksum on every
        // retry, independent of OS/picker order.
        const ordered = [...files].sort((left, right) =>
          relativePath(left as FileWithPath).localeCompare(relativePath(right as FileWithPath)),
        )
        for (const file of ordered) {
          const path = relativePath(file as FileWithPath)
          zip.file(path, await file.arrayBuffer(), { date: ZIP_EPOCH, createFolders: false })
        }
        return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE", compressionOptions: { level: 6 } })
      },
    }
  }
  return entries
}
