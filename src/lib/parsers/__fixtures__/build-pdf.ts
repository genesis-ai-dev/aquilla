// AQU-2551: write small PDFs for the PDF import's tests, so a test states the
// exact pages, tags and text it reads. Helvetica (a standard font, nothing
// embedded), ASCII text, plus en and em dashes and the bullet. A page can be tagged (each run in a marked
// content span owned by a structure element), carry running artifacts, or
// paint an image (a "scanned" page).

export interface PdfFixtureRun {
  text: string
  x: number
  y: number
  size?: number
  /** The structure element that owns this run (see `PdfFixtureElement.id`). */
  tag?: string
  /** A running header, footer or page number: marked as an Artifact. */
  artifact?: boolean
}

export interface PdfFixturePage {
  runs?: PdfFixtureRun[]
  /** Paint a small image (a scanned page holds only this). */
  image?: boolean
}

/** A structure element. Leaves name the runs they own by `id` (the runs'
 *  `tag`); a run may only be owned once. */
export interface PdfFixtureElement {
  role: string
  id?: string
  children?: PdfFixtureElement[]
}

export interface PdfFixture {
  pages: PdfFixturePage[]
  /** The structure tree's top elements; absent = an untagged PDF. */
  structure?: PdfFixtureElement[]
}

const escapePdfString = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)
/** The few non-ASCII characters the tests use, in WinAnsi. */
const WIN_ANSI: Record<string, string> = { "\u2013": "\x96", "\u2014": "\x97", "\u2022": "\x95" }
const toWinAnsi = (s: string) => s.replace(/[\u2013\u2014\u2022]/g, (c) => WIN_ANSI[c])

export function buildPdf(fixture: PdfFixture): ArrayBuffer {
  const objects: string[] = [] // objects[i] is object number i + 1
  const reserve = () => { objects.push(""); return objects.length }
  const set = (num: number, body: string) => { objects[num - 1] = body }

  const catalog = reserve()
  const pagesObj = reserve()
  const font = reserve()
  set(font, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
  const image = reserve()
  set(image, "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n\u0000ÿÿ\u0000\nendstream")

  const tagged = fixture.structure !== undefined
  const pageNums = fixture.pages.map(() => reserve())
  // run tag → { page index, mcid }
  const mcids = new Map<string, { page: number; mcid: number }>()

  fixture.pages.forEach((page, pageIndex) => {
    let mcid = 0
    const parts: string[] = []
    for (const run of page.runs ?? []) {
      const text = `BT /F1 ${run.size ?? 11} Tf ${run.x} ${run.y} Td (${escapePdfString(toWinAnsi(run.text))}) Tj ET`
      if (run.artifact) parts.push(`/Artifact BMC ${text} EMC`)
      else if (tagged && run.tag) {
        if (mcids.has(run.tag)) throw new Error(`run tag ${run.tag} used twice`)
        mcids.set(run.tag, { page: pageIndex, mcid })
        parts.push(`/Span <</MCID ${mcid}>> BDC ${text} EMC`)
        mcid++
      } else parts.push(text)
    }
    if (page.image) parts.push("q 400 0 0 500 100 150 cm /Im1 Do Q")
    const stream = parts.join("\n")
    const content = reserve()
    set(content, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    set(pageNums[pageIndex],
      `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R ` +
      `/Resources << /Font << /F1 ${font} 0 R >> /XObject << /Im1 ${image} 0 R >> >>` +
      (tagged ? ` /StructParents ${pageIndex}` : "") + " >>")
  })
  set(pagesObj, `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`)

  if (!tagged) {
    set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`)
  } else {
    const root = reserve()
    // parent tree: per page, the element owning each MCID
    const parentTree: (number | undefined)[][] = fixture.pages.map(() => [])
    const writeElement = (el: PdfFixtureElement, parent: number): number => {
      const num = reserve()
      const kids: string[] = []
      let pageRef = ""
      for (const child of el.children ?? []) kids.push(`${writeElement(child, num)} 0 R`)
      if (el.id) {
        const at = mcids.get(el.id)
        if (!at) throw new Error(`no run tagged ${el.id}`)
        kids.push(String(at.mcid))
        parentTree[at.page][at.mcid] = num
        pageRef = ` /Pg ${pageNums[at.page]} 0 R`
      }
      set(num, `<< /Type /StructElem /S /${el.role} /P ${parent} 0 R${pageRef} /K [${kids.join(" ")}] >>`)
      return num
    }
    const top = (fixture.structure ?? []).map((el) => writeElement(el, root))
    const nums = parentTree.map((list, i) => `${i} [${list.map((n) => (n ? `${n} 0 R` : "null")).join(" ")}]`).join(" ")
    set(root, `<< /Type /StructTreeRoot /K [${top.map((n) => `${n} 0 R`).join(" ")}] /ParentTree << /Nums [${nums}] >> >>`)
    set(catalog, `<< /Type /Catalog /Pages ${pagesObj} 0 R /MarkInfo << /Marked true >> /StructTreeRoot ${root} 0 R >>`)
  }

  // Every character is one byte (Latin-1), so string offsets are byte offsets.
  let out = "%PDF-1.7\n"
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const bytes = new Uint8Array(out.length)
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff
  return bytes.buffer
}

/**
 * A document set as a PDF: each paragraph wrapped into lines of about 80
 * characters, a blank line's space between paragraphs, new pages as needed.
 * A paragraph starting "# " is a heading (larger type; an H1 when tagged).
 * Latin-1 text only.
 */
export function pdfOfParagraphs(paragraphs: readonly string[], options?: { tagged?: boolean }): ArrayBuffer {
  const pages: PdfFixturePage[] = [{ runs: [] }]
  const structure: PdfFixtureElement[] = []
  let y = 760
  paragraphs.forEach((raw, i) => {
    const heading = raw.startsWith("# ")
    const text = heading ? raw.slice(2) : raw
    const size = heading ? 16 : 11
    const lines: string[] = []
    let line = ""
    for (const word of text.split(" ")) {
      if (line && line.length + 1 + word.length > 80) { lines.push(line); line = word }
      else line = line ? `${line} ${word}` : word
    }
    if (line) lines.push(line)
    const element: PdfFixtureElement = { role: heading ? "H1" : "P", children: [] }
    structure.push(element)
    lines.forEach((l, k) => {
      if (y < 80) { pages.push({ runs: [] }); y = 760 }
      const tag = `p${i}-${k}`
      pages[pages.length - 1].runs!.push({ text: l, x: 72, y, size, tag })
      element.children!.push({ role: "Span", id: tag })
      y -= size * 1.3
    })
    y -= 14
  })
  return buildPdf({ pages, ...(options?.tagged ? { structure: [{ role: "Document", children: structure }] } : {}) })
}
