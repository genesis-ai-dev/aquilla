import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import JSZip from "jszip"
import { renderIdmlFlow } from "./idml-flow"

const page = (name: string) => `Page ${name}`

const story = (id: string, inner: string) =>
  `<?xml version="1.0"?><idPkg:Story xmlns:idPkg="urn:x"><Story Self="${id}">${inner}</Story></idPkg:Story>`
const para = (text: string, style = "ParagraphStyle/Body", extra = "") =>
  `<ParagraphStyleRange AppliedParagraphStyle="${style}"${extra}><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>${text}</Content><Br/></CharacterStyleRange></ParagraphStyleRange>`
const frame = (storyId: string, x: number, y: number) =>
  `<TextFrame Self="f-${storyId}" ParentStory="${storyId}" ItemTransform="1 0 0 1 ${x} ${y}"><Properties><PathGeometry><GeometryPathType><PathPointArray><PathPointType Anchor="0 0"/><PathPointType Anchor="100 50"/></PathPointArray></GeometryPathType></PathGeometry></Properties></TextFrame>`

/**
 * A two-page spread. The stories are listed in designmap in the order a
 * designer made them (footer, body, title), and placed title, body, footer
 * down page 1, with a sidebar on page 2 and a running head on the master.
 */
async function pkg(overrides: Record<string, string> = {}): Promise<ArrayBuffer> {
  const files: Record<string, string> = {
    "designmap.xml": `<?xml version="1.0"?><Document xmlns:idPkg="urn:x">${["footer", "body", "title", "side", "head", "boxed"].map((s) => `<idPkg:Story src="Stories/Story_${s}.xml"/>`).join("")}<idPkg:MasterSpread src="MasterSpreads/m.xml"/><idPkg:Spread src="Spreads/s1.xml"/></Document>`,
    "Resources/Styles.xml": `<?xml version="1.0"?><idPkg:Styles xmlns:idPkg="urn:x"><RootParagraphStyleGroup><ParagraphStyle Self="ParagraphStyle/Body" PointSize="10" Justification="LeftJustified" FirstLineIndent="12"/><ParagraphStyle Self="ParagraphStyle/Title" PointSize="24" FontStyle="Bold" Justification="CenterAlign" FillColor="Color/Red"><Properties><BasedOn type="object">ParagraphStyle/Body</BasedOn></Properties></ParagraphStyle></RootParagraphStyleGroup><RootCharacterStyleGroup><CharacterStyle Self="CharacterStyle/Em" FontStyle="Italic"/></RootCharacterStyleGroup></idPkg:Styles>`,
    "Resources/Graphic.xml": `<?xml version="1.0"?><idPkg:Graphic xmlns:idPkg="urn:x"><Color Self="Color/Red" Space="CMYK" ColorValue="0 100 100 0"/><Color Self="Color/Paper" Space="CMYK" ColorValue="0 0 0 0"/></idPkg:Graphic>`,
    "Spreads/s1.xml": `<?xml version="1.0"?><idPkg:Spread xmlns:idPkg="urn:x"><Spread Self="s1"><Page Self="p1" Name="1" GeometricBounds="0 0 800 600" ItemTransform="1 0 0 1 -600 -400"/><Page Self="p2" Name="2" GeometricBounds="0 0 800 600" ItemTransform="1 0 0 1 0 -400"/>${frame("side", 50, -300)}${frame("footer", -550, 300)}${frame("body", -550, -200)}${frame("title", -550, -350)}</Spread></idPkg:Spread>`,
    "MasterSpreads/m.xml": `<?xml version="1.0"?><idPkg:MasterSpread xmlns:idPkg="urn:x"><MasterSpread Self="m">${frame("head", 0, 0)}</MasterSpread></idPkg:MasterSpread>`,
    "Stories/Story_title.xml": story("title", para("The Title", "ParagraphStyle/Title")),
    "Stories/Story_body.xml": story("body",
      `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]"><Content>First &lt;b&gt; paragraph</Content><Br/><Content>Second </Content></CharacterStyleRange><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Em"><Content>stressed</Content><TextFrame Self="anchor" ParentStory="boxed"/><Br/></CharacterStyleRange></ParagraphStyleRange>`),
    "Stories/Story_footer.xml": story("footer", para("The footer", "ParagraphStyle/Body", ' Justification="RightAlign"')),
    "Stories/Story_side.xml": story("side", para("The sidebar")),
    "Stories/Story_head.xml": story("head", para("Running head")),
    "Stories/Story_boxed.xml": story("boxed", para("In a box")),
    ...overrides,
  }
  const zip = new JSZip()
  for (const [path, text] of Object.entries(files)) zip.file(path, text)
  return zip.generateAsync({ type: "arraybuffer" })
}

/** The page as a reader would scan it: text only, in order. */
function words(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html")
  for (const style of doc.querySelectorAll("style")) style.remove()
  return Array.from(doc.querySelectorAll("p, .page-mark")).map((el) => el.textContent).join(" / ")
}

describe("renderIdmlFlow", () => {
  // designmap lists stories in the order they were made. A translator reads
  // the title before the body, so the preview follows where frames sit.
  it("draws stories in the order their frames sit on the pages, not the order in designmap", async () => {
    const flow = await renderIdmlFlow(await pkg(), page)
    expect(words(flow.html)).toBe(
      "Page 1 / The Title / First <b> paragraph / Second stressed / In a box / The footer / Page 2 / The sidebar",
    )
    expect(flow.stories).toBe(4)
  })

  // A running head is on every page of the layout; here it would be one stray
  // line at an arbitrary place.
  it("leaves out a story only a master spread places", async () => {
    expect((await renderIdmlFlow(await pkg(), page)).html).not.toContain("Running head")
  })

  // The point of the styles: a heading looks like a heading. A style takes
  // what its parent sets and overrides what it sets itself.
  it("draws a paragraph in its style, with what the style inherits", async () => {
    const { html } = await renderIdmlFlow(await pkg(), page)
    const cls = /<p dir="auto" class="(ps\d+)">The Title/.exec(html)?.[1]
    expect(cls).toBeTruthy()
    const rule = new RegExp(`\\.${cls}\\{([^}]*)\\}`).exec(html)?.[1] ?? ""
    expect(rule).toContain("font-size:24pt")
    expect(rule).toContain("font-weight:700")
    expect(rule).toContain("text-align:center")
    expect(rule).toContain("color:rgb(255,0,0)")
    // From Body, through BasedOn.
    expect(rule).toContain("text-indent:12pt")
  })

  it("draws formatting set on a range itself over its style", async () => {
    const { html } = await renderIdmlFlow(await pkg(), page)
    expect(html).toMatch(/<p dir="auto" class="ps\d+" style="text-align:right">The footer/)
    expect(html).toMatch(/<span class="cs\d+">stressed<\/span>/)
  })

  // The frame runs no scripts, but the text is still escaped: a line that
  // holds markup must show as that markup, not vanish into the page.
  it("shows text that looks like markup as text", async () => {
    const { html } = await renderIdmlFlow(await pkg(), page)
    expect(html).toContain("First &lt;b&gt; paragraph")
    expect(html).not.toContain("<b>")
  })

  // White text sits on a dark frame the preview does not draw.
  it("does not draw near-white text on its white page", async () => {
    const styles = `<?xml version="1.0"?><idPkg:Styles xmlns:idPkg="urn:x"><ParagraphStyle Self="ParagraphStyle/Body" FillColor="Color/Paper"/><ParagraphStyle Self="ParagraphStyle/Title"/></idPkg:Styles>`
    const { html } = await renderIdmlFlow(await pkg({ "Resources/Styles.xml": styles }), page)
    expect(html).not.toMatch(/\.ps\d+\{[^}]*color:/)
    expect(html).toContain("The Title")
  })

  // The package the importer's own tests use: tables, notes, anchored frames,
  // unknown inline objects. Whatever it holds, the preview must still draw.
  it("draws the round-trip engine's feature-rich fixture", async () => {
    const bytes = readFileSync("packages/idml-roundtrip/fixtures/valid/feature-rich.idml")
    const flow = await renderIdmlFlow(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, page)
    expect(flow.stories).toBeGreaterThan(0)
    expect(flow.html).toContain("outer cell")
    // Text inside a hyperlink that also holds a picture: both are drawn.
    expect(flow.html).toContain("漢字とかな")
    expect(flow.html).toContain('class="picture"')
    expect(flow.html).toContain("<table>")
    expect(flow.html).not.toContain("translator note")
  })
})
