/**
 * IDML package: open, list stories/spreads, and read members.
 */
import { entryText, readZip, ZipError } from "../zip.ts"
import type { ZipArchive, ZipEntry } from "../zip.ts"
import { parseXml, walk } from "../xml.ts"

export const IDML_MIMETYPE = "application/vnd.adobe.indesign-idml-package"

export interface IdmlPackage {
  readonly archive: ZipArchive
  readonly byName: ReadonlyMap<string, ZipEntry>
  readonly stories: string[]
  readonly spreads: string[]
  readonly masterSpreads: string[]
}

export const openIdml = (bytes: Uint8Array): IdmlPackage => {
  const archive = readZip(bytes)
  const first = archive.entries[0]
  if (!first || first.name !== "mimetype") throw new ZipError("INVALID_MIMETYPE", "IDML packages must start with a stored 'mimetype' member")
  if (first.method !== 0) throw new ZipError("INVALID_MIMETYPE", "the 'mimetype' member must be stored, not compressed")
  if (entryText(first).trim() !== IDML_MIMETYPE) throw new ZipError("INVALID_MIMETYPE", `unexpected mimetype '${entryText(first).trim()}'`)
  const byName = new Map(archive.entries.map((e) => [e.name, e]))
  const designmap = byName.get("designmap.xml")
  if (!designmap) throw new ZipError("MISSING_DESIGNMAP", "designmap.xml is missing")
  const dm = parseXml(entryText(designmap))
  const stories: string[] = []
  const spreads: string[] = []
  const masterSpreads: string[] = []
  for (const el of walk(dm.root)) {
    const src = el.attrs.src
    if (!src) continue
    if (el.name.endsWith(":Story")) stories.push(src)
    else if (el.name.endsWith(":Spread")) spreads.push(src)
    else if (el.name.endsWith(":MasterSpread")) masterSpreads.push(src)
  }
  for (const s of [...stories, ...spreads, ...masterSpreads]) {
    if (!byName.has(s)) throw new ZipError("MISSING_STORY", `designmap.xml references missing member ${s}`)
  }
  return { archive, byName, stories, spreads, masterSpreads }
}

export const memberText = (pkg: IdmlPackage, name: string): string => {
  const e = pkg.byName.get(name)
  if (!e) throw new ZipError("MEMBER_MISSING", `missing member ${name}`)
  return entryText(e)
}

/** Story ids placed on master spreads (their text repeats on every page using the master). */
export const masterStoryIds = (pkg: IdmlPackage): Set<string> => {
  const ids = new Set<string>()
  for (const m of pkg.masterSpreads) {
    for (const el of walk(parseXml(memberText(pkg, m)).root)) {
      if ((el.name === "TextFrame" || el.name === "TextPath") && el.attrs.ParentStory) ids.add(el.attrs.ParentStory)
    }
  }
  return ids
}
