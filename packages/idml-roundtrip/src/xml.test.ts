import { describe, expect, it } from "vitest"
import { IdmlError } from "./errors.js"
import {
  decodeXmlBytes,
  elementDescendants,
  elementPath,
  elementText,
  getAttribute,
  parseXml,
  resolveElementPath,
} from "./xml.js"

describe("strict IDML XML parser", () => {
  it("preserves offsets, BOM, CRLF, declarations, namespaces, comments, and CDATA", () => {
    const source =
      '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n' +
      '<idPkg:Story xmlns:idPkg="urn:adobe:ns:indesign/idml/1.0/packaging">\r\n' +
      "  <!-- retained -->\r\n" +
      '  <Story Self="u1"><Content>A &amp; <![CDATA[B < C]]></Content></Story>\r\n' +
      "</idPkg:Story>"
    const document = parseXml(source, "Stories/Story_u1.xml")
    const content = elementDescendants(
      document.root,
      (element) => element.localName === "Content",
    )[0]!

    expect(document.source).toBe(source)
    expect(document.root.name).toBe("idPkg:Story")
    expect(getAttribute(document.root, "xmlns:idPkg")).toBe(
      "urn:adobe:ns:indesign/idml/1.0/packaging",
    )
    expect(elementText(content)).toBe("A & B < C")
    expect(source.slice(content.start, content.end)).toBe(
      "<Content>A &amp; <![CDATA[B < C]]></Content>",
    )
    expect(elementPath(content)).toBe("/idPkg:Story[1]/Story[1]/Content[1]")
    expect(resolveElementPath(document, elementPath(content))).toBe(content)
  })

  it("decodes only predefined and valid numeric XML entities", () => {
    const document = parseXml(
      "<Root><Content>&lt;&gt;&amp;&quot;&apos;&#65;&#x1F642;</Content></Root>",
    )
    const content = elementDescendants(
      document.root,
      (element) => element.localName === "Content",
    )[0]!
    expect(elementText(content)).toBe(`<>&"'A🙂`)

    expect(() => parseXml("<Root>&nbsp;</Root>")).toThrowError(IdmlError)
    expect(() => parseXml("<Root>&#0;</Root>")).toThrowError(IdmlError)
    expect(() => parseXml("<Root>&amp</Root>")).toThrowError(IdmlError)
  })

  it.each([
    "<Root><A></Root>",
    "<Root a='1' a='2'/>",
    "<Root a=unquoted/>",
    "<Root><A/></Root><Second/>",
    "<Root><![CDATA[unterminated</Root>",
    "<Root><!-- invalid -- comment --></Root>",
    "<Root><A></A>",
    "<?xml encoding='UTF-8'?><Root/>",
    "<?xml version='1.0' standalone='maybe'?><Root/>",
    "<?xml version='1.0' mystery='value'?><Root/>",
    "<?xml encoding='UTF-8' version='1.0'?><Root/>",
    " \n<?xml version='1.0'?><Root/>",
    "<Root a='1'b='2'/>",
    "<Root><A></ A></Root>",
    "<Root>invalid ]]&gt; sequence ]]></Root>",
  ])("rejects malformed XML: %s", (source) => {
    expect(() => parseXml(source, "bad.xml")).toThrowError(
      expect.objectContaining({ code: "MALFORMED_XML" }),
    )
  })

  it.each([
    "<!DOCTYPE Root><Root/>",
    '<!DOCTYPE Root [<!ENTITY x "boom">]><Root>&x;</Root>',
    '<!ENTITY x "boom"><Root/>',
    "<?xml version='1.1'?><Root/>",
  ])("rejects DTD and ENTITY declarations: %s", (source) => {
    expect(() => parseXml(source, "unsafe.xml")).toThrowError(
      expect.objectContaining({ code: "UNSAFE_XML_DECLARATION" }),
    )
  })

  it("accepts UTF-8 bytes without normalizing BOM or line endings", () => {
    const source = '\uFEFF<?xml version="1.0"?>\r\n<Root>e\u0301</Root>\r\n'
    const decoded = decodeXmlBytes(new TextEncoder().encode(source), "member.xml")
    expect(decoded).toBe(source)
    expect(parseXml(decoded).source).toBe(source)
  })

  it("rejects unsupported encodings and invalid UTF-8", () => {
    expect(() =>
      decodeXmlBytes(
        new TextEncoder().encode('<?xml version="1.0" encoding="UTF-16"?><Root/>'),
        "member.xml",
      ),
    ).toThrowError(expect.objectContaining({ code: "UNSAFE_XML_DECLARATION" }))
    expect(() => decodeXmlBytes(Uint8Array.from([0xc3, 0x28]), "member.xml")).toThrowError(
      expect.objectContaining({ code: "MALFORMED_XML" }),
    )
  })

  it("uses same-name sibling indexes in stable element paths", () => {
    const document = parseXml("<Root><A/><B/><A><A/></A></Root>")
    const elements = elementDescendants(document.root)
    const secondA = elements.find(
      (element) => elementPath(element) === "/Root[1]/A[2]",
    )!
    expect(resolveElementPath(document, "/Root[1]/A[2]")).toBe(secondA)
    expect(resolveElementPath(document, "/Root[1]/A[2]/A[1]")?.localName).toBe("A")
    expect(resolveElementPath(document, "/Root[1]/A[3]")).toBeNull()
  })
})
