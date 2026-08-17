// EPUB importer/exporter pair for CAT content-only round trip.
//
// An EPUB is a ZIP package: META-INF/container.xml names the OPF, the OPF
// spine lists XHTML members in reading order. Import walks that spine and
// reuses the HTML block extractor so chapter markup and HTML files share one
// block-selection rule. Export injects translations back into the same
// members and re-zips the original package.
//
// Fidelity is content-only: translated XHTML is re-serialized through the
// HTML parser (same known inline-markup loss as the HTML importer). CSS,
// images, fonts, and the OPF/NCX/nav package stay byte-for-byte.

import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import { applyHtmlTranslations, extractHtmlStrings } from "./html"
import type { SourceLocation, TranslatableString } from "./types"
import { assertSafeArchiveInputSize, assertSafeZipArchive } from "./zip-safety"

const CONTAINER_PATH = "META-INF/container.xml"
const HTML_MEDIA_TYPES = new Set([
  "application/xhtml+xml",
  "text/html",
  "application/x-dtbook+xml",
])
const HTML_EXTRACT_OPTIONS = { skipDocumentTitle: true } as const

export const EPUB_MEMBER_ROLES = ["chapter", "nav", "cover", "notes", "empty"] as const
export type EpubMemberRole = (typeof EPUB_MEMBER_ROLES)[number]

export interface EpubSpineMember {
  memberPath: string
  role: EpubMemberRole
  linear: boolean
  includedByDefault: boolean
  title: string
  cellCount: number
}

export interface EpubExtractResult {
  strings: TranslatableString[]
  members: EpubSpineMember[]
}

interface EpubChapter {
  memberPath: string
  html: string
  id: string
  href: string
  properties: string
  linear: boolean
}

interface EpubPackage {
  archive: JSZip
  title: string
  chapters: EpubChapter[]
}

function elementsByLocalName(root: Document | Element, localName: string): Element[] {
  const wanted = localName.toLowerCase()
  return Array.from(root.getElementsByTagName("*")).filter(
    (el) => el.localName.toLowerCase() === wanted,
  )
}

function normalizeZipPath(path: string): string {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return parts.join("/")
}

function resolvePackageHref(opfPath: string, href: string): string {
  const withoutFragment = href.split("#")[0] ?? href
  let decoded = withoutFragment
  try {
    decoded = decodeURIComponent(withoutFragment)
  } catch {
    // Keep the raw href when it is not valid percent-encoding.
  }
  const slash = opfPath.lastIndexOf("/")
  const base = slash >= 0 ? opfPath.slice(0, slash + 1) : ""
  return normalizeZipPath(`${base}${decoded}`)
}

function zipEntry(archive: JSZip, path: string) {
  const exact = archive.file(path)
  if (exact) return exact
  const wanted = path.toLowerCase()
  const match = Object.keys(archive.files).find((name) => {
    const entry = archive.files[name]
    return !entry.dir && name.toLowerCase() === wanted
  })
  return match ? archive.file(match) : null
}

function parseXml(label: string, xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml")
  const err = doc.querySelector("parsererror")
  if (err) throw new Error(`${label} is not valid XML.`)
  return doc
}

function packageTitle(opf: Document): string {
  const title = elementsByLocalName(opf, "title")
    .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
    .find(Boolean)
  return title ?? ""
}

function chapterTitle(strings: TranslatableString[], memberPath: string, bookTitle: string): string {
  const heading = strings.find((value) => value.type === "heading")
  if (heading?.original) return heading.original
  if (bookTitle) return bookTitle
  const base = memberPath.split("/").pop() ?? memberPath
  return base.replace(/\.[^.]+$/, "") || memberPath
}

export function classifyEpubMember(input: {
  id: string
  href: string
  properties: string
  linear: boolean
  cellCount: number
}): EpubMemberRole {
  if (input.cellCount === 0) return "empty"
  const properties = input.properties.toLowerCase()
  const id = input.id.toLowerCase()
  const href = input.href.toLowerCase()
  if (
    properties.split(/\s+/).includes("nav")
    || id === "nav"
    || id === "toc"
    || /(^|\/)(nav|toc)(?:[-_.]|$)/.test(href)
  ) {
    return "nav"
  }
  if (properties.split(/\s+/).includes("cover") || /\bcover\b/.test(id) || /\bcover\b/.test(href)) {
    return "cover"
  }
  if (!input.linear) return "notes"
  return "chapter"
}

function includedByDefault(role: EpubMemberRole): boolean {
  return role === "chapter"
}

async function loadEpubPackage(buffer: ArrayBuffer): Promise<EpubPackage> {
  assertSafeArchiveInputSize(buffer.byteLength, "EPUB file")
  const archive = await JSZip.loadAsync(buffer)
  assertSafeZipArchive(archive, "EPUB file")

  const containerEntry = zipEntry(archive, CONTAINER_PATH)
  if (!containerEntry) {
    throw new Error("EPUB file is not a valid package (missing META-INF/container.xml).")
  }
  const container = parseXml("EPUB container", await containerEntry.async("string"))
  const rootfile = elementsByLocalName(container, "rootfile")
    .map((el) => el.getAttribute("full-path")?.trim() ?? "")
    .find(Boolean)
  if (!rootfile) {
    throw new Error("EPUB file does not name a package document.")
  }

  const opfPath = normalizeZipPath(rootfile)
  const opfEntry = zipEntry(archive, opfPath)
  if (!opfEntry) {
    throw new Error("EPUB file is missing its package document.")
  }
  const opf = parseXml("EPUB package document", await opfEntry.async("string"))
  const manifest = new Map<string, Element>()
  for (const item of elementsByLocalName(opf, "item")) {
    const id = item.getAttribute("id")?.trim()
    if (id) manifest.set(id, item)
  }

  const chapters: EpubChapter[] = []
  const seen = new Set<string>()
  for (const itemref of elementsByLocalName(opf, "itemref")) {
    const idref = itemref.getAttribute("idref")?.trim()
    if (!idref) continue
    const item = manifest.get(idref)
    const mediaType = item?.getAttribute("media-type")?.trim().toLowerCase() ?? ""
    if (!item || !HTML_MEDIA_TYPES.has(mediaType)) continue
    const href = item.getAttribute("href")?.trim()
    if (!href) continue
    const memberPath = resolvePackageHref(opfPath, href)
    if (seen.has(memberPath.toLowerCase())) continue
    const member = zipEntry(archive, memberPath)
    if (!member) {
      throw new Error(`EPUB file is missing a spine chapter: ${memberPath}`)
    }
    seen.add(memberPath.toLowerCase())
    chapters.push({
      memberPath,
      html: await member.async("string"),
      id: idref,
      href,
      properties: item.getAttribute("properties")?.trim() ?? "",
      linear: itemref.getAttribute("linear")?.trim().toLowerCase() !== "no",
    })
  }

  if (chapters.length === 0) {
    throw new Error("EPUB file does not contain any readable chapters.")
  }

  return { archive, title: packageTitle(opf), chapters }
}

export async function extractEpubImport(buffer: ArrayBuffer): Promise<EpubExtractResult> {
  const pack = await loadEpubPackage(buffer)
  const strings: TranslatableString[] = []
  const members: EpubSpineMember[] = []

  for (const chapter of pack.chapters) {
    const extracted = extractHtmlStrings(chapter.html, HTML_EXTRACT_OPTIONS)
    const role = classifyEpubMember({
      id: chapter.id,
      href: chapter.href,
      properties: chapter.properties,
      linear: chapter.linear,
      cellCount: extracted.length,
    })
    const title = chapterTitle(extracted, chapter.memberPath, pack.title)
    members.push({
      memberPath: chapter.memberPath,
      role,
      linear: chapter.linear,
      includedByDefault: includedByDefault(role),
      title,
      cellCount: extracted.length,
    })
    if (extracted.length === 0) continue
    for (const value of extracted) {
      const sourceLocation: SourceLocation = {
        file: chapter.memberPath,
        blockPath: value.sourceLocation?.blockPath ?? String(strings.length),
      }
      strings.push({
        ...value,
        section: title,
        context: title ? `${title} · ${value.context}` : value.context,
        sourceLocation,
      })
    }
  }

  if (strings.length === 0) {
    throw new Error("EPUB file did not contain any importable text.")
  }
  return { strings, members }
}

export async function extractEpubStrings(buffer: ArrayBuffer): Promise<TranslatableString[]> {
  return (await extractEpubImport(buffer)).strings
}

export function defaultEpubSkipMemberPaths(members: readonly EpubSpineMember[]): Set<string> {
  return new Set(
    members
      .filter((member) => !member.includedByDefault)
      .map((member) => member.memberPath.toLowerCase()),
  )
}

export function filterEpubStrings<T extends { sourceLocation?: SourceLocation }>(
  strings: readonly T[],
  skipMemberPaths: ReadonlySet<string>,
): T[] {
  if (skipMemberPaths.size === 0) return [...strings]
  const skip = new Set([...skipMemberPaths].map((path) => path.toLowerCase()))
  return strings.filter((value) => !skip.has((value.sourceLocation?.file ?? "").toLowerCase()))
}

export async function exportEpub(
  originalBytes: ArrayBuffer,
  cells: Array<Pick<CellData, "translated" | "original"> & { sourceLocation?: SourceLocation }>,
): Promise<Blob> {
  const pack = await loadEpubPackage(originalBytes)
  const byMember = new Map<string, typeof cells>()
  for (const cell of cells) {
    const memberPath = cell.sourceLocation?.file
    if (!memberPath) continue
    const list = byMember.get(memberPath) ?? []
    list.push(cell)
    byMember.set(memberPath, list)
  }

  for (const chapter of pack.chapters) {
    const chapterCells = byMember.get(chapter.memberPath)
    if (!chapterCells?.length) continue
    pack.archive.file(
      chapter.memberPath,
      applyHtmlTranslations(chapter.html, chapterCells, HTML_EXTRACT_OPTIONS),
    )
  }

  return pack.archive.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
  })
}
