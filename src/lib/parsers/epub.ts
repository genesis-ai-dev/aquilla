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

interface EpubChapter {
  memberPath: string
  html: string
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
    })
  }

  if (chapters.length === 0) {
    throw new Error("EPUB file does not contain any readable chapters.")
  }

  return { archive, title: packageTitle(opf), chapters }
}

export async function extractEpubStrings(buffer: ArrayBuffer): Promise<TranslatableString[]> {
  const pack = await loadEpubPackage(buffer)
  const results: TranslatableString[] = []

  for (const chapter of pack.chapters) {
    const strings = extractHtmlStrings(chapter.html)
    if (strings.length === 0) continue
    const section = chapterTitle(strings, chapter.memberPath, pack.title)
    for (const value of strings) {
      const sourceLocation: SourceLocation = {
        file: chapter.memberPath,
        blockPath: value.sourceLocation?.blockPath ?? String(results.length),
      }
      results.push({
        ...value,
        section,
        context: section ? `${section} · ${value.context}` : value.context,
        sourceLocation,
      })
    }
  }

  if (results.length === 0) {
    throw new Error("EPUB file did not contain any importable text.")
  }
  return results
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
    pack.archive.file(chapter.memberPath, applyHtmlTranslations(chapter.html, chapterCells))
  }

  return pack.archive.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
    compression: "DEFLATE",
  })
}
