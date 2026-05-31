import { describe, it, expect } from "vitest"
import { parseXliff } from "./xliff"

// ─── XLIFF 1.2 ───────────────────────────────────────────────────────────────

describe("parseXliff — XLIFF 1.2", () => {
  it("parses a minimal XLIFF 1.2 document", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en" target-language="fr">
    <body>
      <trans-unit id="tu1">
        <source>Hello world</source>
        <target>Bonjour monde</target>
      </trans-unit>
    </body>
  </file>
</xliff>`
    const result = parseXliff(xml)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].translated).toBe("Bonjour monde")
    expect(result[0].type).toBe("text")
  })

  it("handles missing <target> — translated is empty string", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en" target-language="fr">
    <body>
      <trans-unit id="tu-no-target">
        <source>Source only</source>
      </trans-unit>
    </body>
  </file>
</xliff>`
    const result = parseXliff(xml)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Source only")
    expect(result[0].translated).toBe("")
  })

  it("skips trans-units with empty source", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en" target-language="fr">
    <body>
      <trans-unit id="empty">
        <source>   </source>
        <target>something</target>
      </trans-unit>
      <trans-unit id="real">
        <source>Keep this</source>
        <target>Garder cela</target>
      </trans-unit>
    </body>
  </file>
</xliff>`
    const result = parseXliff(xml)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Keep this")
  })

  it("strips inline markup and preserves text content", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en" target-language="fr">
    <body>
      <trans-unit id="inline">
        <source>Hello <g id="1">beautiful</g> world</source>
        <target>Bonjour <g id="1">beau</g> monde</target>
      </trans-unit>
    </body>
  </file>
</xliff>`
    const result = parseXliff(xml)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello beautiful world")
    expect(result[0].translated).toBe("Bonjour beau monde")
  })

  it("uses <note> as context when present", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en" target-language="fr">
    <body>
      <trans-unit id="noted">
        <source>Click here</source>
        <target>Cliquez ici</target>
        <note>Button label on login page</note>
      </trans-unit>
    </body>
  </file>
</xliff>`
    const result = parseXliff(xml)
    expect(result[0].context).toBe("Button label on login page")
  })

  it("handles XLIFF 1.2 without default namespace (no-ns)", () => {
    const xml = `<?xml version="1.0"?>
<xliff version="1.2">
  <file source-language="en">
    <body>
      <trans-unit id="t1">
        <source>No namespace</source>
        <target>Sans espace de noms</target>
      </trans-unit>
    </body>
  </file>
</xliff>`
    const result = parseXliff(xml)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("No namespace")
  })

  it("handles CDATA sections in source/target", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2">
  <file source-language="en">
    <body>
      <trans-unit id="cdata">
        <source><![CDATA[Hello & <world>]]></source>
        <target><![CDATA[Bonjour & <monde>]]></target>
      </trans-unit>
    </body>
  </file>
</xliff>`
    const result = parseXliff(xml)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello & <world>")
    expect(result[0].translated).toBe("Bonjour & <monde>")
  })

  it("handles multiple trans-units across multiple files", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en" target-language="fr" original="file1.txt">
    <body>
      <trans-unit id="f1-1"><source>File 1 unit 1</source><target>Fichier 1 unité 1</target></trans-unit>
    </body>
  </file>
  <file source-language="en" target-language="fr" original="file2.txt">
    <body>
      <trans-unit id="f2-1"><source>File 2 unit 1</source><target>Fichier 2 unité 1</target></trans-unit>
    </body>
  </file>
</xliff>`
    const result = parseXliff(xml)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("File 1 unit 1")
    expect(result[1].original).toBe("File 2 unit 1")
  })

  it("assigns unique ids to each result", () => {
    const xml = `<?xml version="1.0"?>
<xliff version="1.2">
  <file source-language="en">
    <body>
      <trans-unit id="a"><source>A</source></trans-unit>
      <trans-unit id="b"><source>B</source></trans-unit>
    </body>
  </file>
</xliff>`
    const result = parseXliff(xml)
    expect(result[0].id).not.toBe(result[1].id)
  })
})

// ─── XLIFF 2.0 ───────────────────────────────────────────────────────────────

describe("parseXliff — XLIFF 2.0", () => {
  it("parses a minimal XLIFF 2.0 document", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0"
       srcLang="en" trgLang="fr">
  <file id="f1">
    <unit id="u1">
      <segment>
        <source>Hello world</source>
        <target>Bonjour monde</target>
      </segment>
    </unit>
  </file>
</xliff>`
    const result = parseXliff(xml)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].translated).toBe("Bonjour monde")
  })

  it("emits one TranslatableString per segment — no text is lost across segments", () => {
    // New behavior: each <segment> in a <unit> becomes its own TranslatableString,
    // preserving segment granularity for review. Previously this concatenated all
    // segments into one entry, which lost segment boundaries.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0"
       srcLang="en" trgLang="fr">
  <file id="f1">
    <unit id="multi-seg">
      <segment id="s1">
        <source>First sentence.</source>
        <target>Première phrase.</target>
      </segment>
      <segment id="s2">
        <source>Second sentence.</source>
        <target>Deuxième phrase.</target>
      </segment>
    </unit>
  </file>
</xliff>`
    const result = parseXliff(xml)
    // Two segments → two entries (no text loss)
    expect(result).toHaveLength(2)
    // All source and target text is accounted for
    const allOriginals = result.map((r) => r.original).join(" ")
    const allTranslated = result.map((r) => r.translated).join(" ")
    expect(allOriginals).toContain("First sentence.")
    expect(allOriginals).toContain("Second sentence.")
    expect(allTranslated).toContain("Première phrase.")
    expect(allTranslated).toContain("Deuxième phrase.")
    // Segments share the same unit group
    expect(result[0].group).toBe("multi-seg")
    expect(result[1].group).toBe("multi-seg")
    // Each segment has its own sourceLocation with segment id
    expect(result[0].sourceLocation?.blockPath).toBe("s1")
    expect(result[1].sourceLocation?.blockPath).toBe("s2")
  })

  it("handles missing <target> in XLIFF 2.0", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0"
       srcLang="en" trgLang="fr">
  <file id="f1">
    <unit id="u1">
      <segment>
        <source>Untranslated</source>
      </segment>
    </unit>
  </file>
</xliff>`
    const result = parseXliff(xml)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Untranslated")
    expect(result[0].translated).toBe("")
  })

  it("parses XLIFF 2.0 with notes", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0"
       srcLang="en" trgLang="fr">
  <file id="f1">
    <unit id="u1">
      <notes>
        <note>Context note for translator</note>
      </notes>
      <segment>
        <source>Buy now</source>
        <target>Acheter maintenant</target>
      </segment>
    </unit>
  </file>
</xliff>`
    const result = parseXliff(xml)
    expect(result[0].context).toBe("Context note for translator")
  })

  it("strips inline markup in XLIFF 2.0 and preserves text", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xliff xmlns="urn:oasis:names:tc:xliff:document:2.0" version="2.0"
       srcLang="en" trgLang="fr">
  <file id="f1">
    <unit id="u1">
      <segment>
        <source>Click <pc id="1">here</pc></source>
        <target>Cliquez <pc id="1">ici</pc></target>
      </segment>
    </unit>
  </file>
</xliff>`
    const result = parseXliff(xml)
    expect(result[0].original).toBe("Click here")
    expect(result[0].translated).toBe("Cliquez ici")
  })
})
