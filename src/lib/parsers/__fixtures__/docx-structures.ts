// Small synthetic WordprocessingML structures for AQU-2539 (text boxes, tabs,
// fields, footnotes, hidden text). Each reproduces one shape found in a
// partner's real file; no partner content is copied. Plain strings only, so
// the module loads in the sync-worker's TypeScript program too.

export const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

export function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${NS}><w:body>${body}</w:body></w:document>`
}

export const run = (text: string, rPr = "") => `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`
export const para = (inner: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}${inner}</w:p>`

/** A text box as Word writes it: the same content in a modern Choice and an
 *  old-reader Fallback, inside one run of the paragraph that anchors it. */
export function textBoxRun(innerParagraphs: string): string {
  return (
    `<w:r><w:rPr><w:noProof/></w:rPr><mc:AlternateContent>` +
    `<mc:Choice Requires="wps"><w:drawing><wp:anchor><wps:wsp><wps:txbx><w:txbxContent>${innerParagraphs}</w:txbxContent></wps:txbx></wps:wsp></wp:anchor></w:drawing></mc:Choice>` +
    `<mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>${innerParagraphs}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>` +
    `</mc:AlternateContent></w:r>`
  )
}

/** A picture run (no text). */
export const pictureRun = `<w:r><w:rPr><w:noProof/></w:rPr><w:drawing><wp:inline><wp:docPr id="7" name="Picture 7"/></wp:inline></w:drawing></w:r>`

/** A complex field: begin, instruction, separate, result, end. */
export function complexField(instr: string, result: string, resultRpr = ""): string {
  return (
    `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
    `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    run(result, resultRpr) +
    `<w:r><w:fldChar w:fldCharType="end"/></w:r>`
  )
}

export const footnoteRefRun = (id: number) =>
  `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`

export function footnotesXml(notes: Record<number, string>): string {
  const body = Object.entries(notes)
    .map(([id, text]) => `<w:footnote w:id="${id}"><w:p><w:r><w:footnoteRef/></w:r>${run(` ${text}`)}</w:p></w:footnote>`)
    .join("")
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:footnotes ${NS}>` +
    `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
    `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>` +
    `${body}</w:footnotes>`
  )
}
