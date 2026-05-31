import { describe, it, expect } from "vitest"
import { parseTmx } from "./tmx"

describe("parseTmx", () => {
  it("parses a minimal TMX document with srclang header", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tmx SYSTEM "tmx14.dtd">
<tmx version="1.4">
  <header srclang="en" adminlang="en" datatype="PlainText" creationtool="test" creationtoolversion="1.0" segtype="sentence" o-tmf="ABCTransMem" />
  <body>
    <tu tuid="tu1">
      <tuv xml:lang="en"><seg>Hello world</seg></tuv>
      <tuv xml:lang="fr"><seg>Bonjour monde</seg></tuv>
    </tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].translated).toBe("Bonjour monde")
    expect(result[0].type).toBe("text")
  })

  it("uses tuid as context", () => {
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header srclang="en" />
  <body>
    <tu tuid="segment-42">
      <tuv xml:lang="en"><seg>Source text</seg></tuv>
      <tuv xml:lang="de"><seg>Quelltext</seg></tuv>
    </tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result[0].context).toBe("segment-42")
    expect(result[0].group).toBe("segment-42")
  })

  it("handles missing srclang — falls back to first tuv language", () => {
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header />
  <body>
    <tu>
      <tuv xml:lang="es"><seg>Hola mundo</seg></tuv>
      <tuv xml:lang="pt"><seg>Olá mundo</seg></tuv>
    </tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hola mundo")
    expect(result[0].translated).toBe("Olá mundo")
  })

  it("handles *all* as srclang — falls back to first tuv", () => {
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header srclang="*all*" />
  <body>
    <tu>
      <tuv xml:lang="en"><seg>All source</seg></tuv>
      <tuv xml:lang="fr"><seg>Toutes sources</seg></tuv>
    </tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result[0].original).toBe("All source")
  })

  it("skips tu with empty source seg", () => {
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header srclang="en" />
  <body>
    <tu tuid="empty">
      <tuv xml:lang="en"><seg>   </seg></tuv>
      <tuv xml:lang="fr"><seg>Quelque chose</seg></tuv>
    </tu>
    <tu tuid="real">
      <tuv xml:lang="en"><seg>Real content</seg></tuv>
      <tuv xml:lang="fr"><seg>Contenu réel</seg></tuv>
    </tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Real content")
  })

  it("handles missing target tuv — translated is empty string", () => {
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header srclang="en" />
  <body>
    <tu tuid="source-only">
      <tuv xml:lang="en"><seg>Only source</seg></tuv>
    </tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Only source")
    expect(result[0].translated).toBe("")
  })

  it("handles inline markup in <seg> — preserves text content", () => {
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header srclang="en" />
  <body>
    <tu>
      <tuv xml:lang="en"><seg>Hello <bpt i="1">&lt;b&gt;</bpt>world<ept i="1">&lt;/b&gt;</ept></seg></tuv>
      <tuv xml:lang="fr"><seg>Bonjour <bpt i="1">&lt;b&gt;</bpt>monde<ept i="1">&lt;/b&gt;</ept></seg></tuv>
    </tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result[0].original).toContain("Hello")
    expect(result[0].original).toContain("world")
  })

  it("includes <note> in context", () => {
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header srclang="en" />
  <body>
    <tu tuid="noted">
      <note>This is a button label</note>
      <tuv xml:lang="en"><seg>Save</seg></tuv>
      <tuv xml:lang="fr"><seg>Enregistrer</seg></tuv>
    </tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result[0].context).toContain("This is a button label")
  })

  it("assigns unique ids to each result", () => {
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header srclang="en" />
  <body>
    <tu tuid="a"><tuv xml:lang="en"><seg>A</seg></tuv><tuv xml:lang="fr"><seg>B</seg></tuv></tu>
    <tu tuid="b"><tuv xml:lang="en"><seg>C</seg></tuv><tuv xml:lang="fr"><seg>D</seg></tuv></tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result).toHaveLength(2)
    expect(result[0].id).not.toBe(result[1].id)
  })

  it("handles language tags case-insensitively", () => {
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header srclang="EN" />
  <body>
    <tu>
      <tuv xml:lang="EN"><seg>Upper case lang</seg></tuv>
      <tuv xml:lang="FR"><seg>Langue en majuscules</seg></tuv>
    </tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result[0].original).toBe("Upper case lang")
    expect(result[0].translated).toBe("Langue en majuscules")
  })

  it("parses TMX without xml namespace prefix on lang", () => {
    // Some tools emit lang= instead of xml:lang=
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header srclang="en" />
  <body>
    <tu>
      <tuv lang="en"><seg>Plain lang attr</seg></tuv>
      <tuv lang="de"><seg>Einfaches lang-Attribut</seg></tuv>
    </tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result[0].original).toBe("Plain lang attr")
    expect(result[0].translated).toBe("Einfaches lang-Attribut")
  })

  it("handles empty body", () => {
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header srclang="en" />
  <body></body>
</tmx>`
    const result = parseTmx(xml)
    expect(result).toHaveLength(0)
  })

  // ─── multilingual TMX (3+ tuv) edge cases ───────────────────────────────

  it("multilingual TMX with 3 tuvs — picks source and first non-source target", () => {
    // A TMX exported from a multi-target TM will have 3+ tuv per tu.
    // We must pick the declared srclang as source and the first other lang as target.
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header srclang="en" />
  <body>
    <tu tuid="multi3">
      <tuv xml:lang="en"><seg>English source</seg></tuv>
      <tuv xml:lang="fr"><seg>French target</seg></tuv>
      <tuv xml:lang="de"><seg>German target</seg></tuv>
    </tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result).toHaveLength(1)
    // Source is always "en" (matches srclang)
    expect(result[0].original).toBe("English source")
    // First non-source is "fr"
    expect(result[0].translated).toBe("French target")
  })

  it("multilingual TMX with source in non-first position", () => {
    // Source tuv is listed second; parser must match by lang, not by position.
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header srclang="en" />
  <body>
    <tu tuid="src-second">
      <tuv xml:lang="fr"><seg>Texte en français</seg></tuv>
      <tuv xml:lang="en"><seg>English text</seg></tuv>
      <tuv xml:lang="de"><seg>Deutscher Text</seg></tuv>
    </tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result[0].original).toBe("English text")
    // First tuv that is not "en" = "fr" (it came first in doc order)
    expect(result[0].translated).toBe("Texte en français")
  })

  it("multilingual TMX with 4 tuvs — extra langs are ignored, no crash", () => {
    const xml = `<?xml version="1.0"?>
<tmx version="1.4">
  <header srclang="en" />
  <body>
    <tu>
      <tuv xml:lang="en"><seg>Source</seg></tuv>
      <tuv xml:lang="fr"><seg>Cible FR</seg></tuv>
      <tuv xml:lang="es"><seg>Objetivo ES</seg></tuv>
      <tuv xml:lang="zh"><seg>目标 ZH</seg></tuv>
    </tu>
  </body>
</tmx>`
    const result = parseTmx(xml)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Source")
    expect(result[0].translated).toBe("Cible FR")
  })
})
