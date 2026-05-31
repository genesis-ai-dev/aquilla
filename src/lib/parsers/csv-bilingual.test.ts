import { describe, it, expect } from "vitest"
import { parseCsvBilingual, parseCsvRows } from "./csv-bilingual"

// ─── parseCsvRows unit tests ─────────────────────────────────────────────────

describe("parseCsvRows — RFC-4180 parser", () => {
  it("parses simple comma-separated rows", () => {
    const rows = parseCsvRows("a,b,c\n1,2,3")
    expect(rows).toEqual([["a", "b", "c"], ["1", "2", "3"]])
  })

  it("parses tab-separated rows", () => {
    const rows = parseCsvRows("a\tb\tc\n1\t2\t3")
    expect(rows).toEqual([["a", "b", "c"], ["1", "2", "3"]])
  })

  it("handles quoted fields with embedded commas", () => {
    const rows = parseCsvRows('"hello, world",b')
    expect(rows[0][0]).toBe("hello, world")
    expect(rows[0][1]).toBe("b")
  })

  it("handles quoted fields with embedded newlines", () => {
    const rows = parseCsvRows('"line one\nline two",end')
    expect(rows[0][0]).toBe("line one\nline two")
  })

  it("handles doubled-quote escape inside quoted field", () => {
    const rows = parseCsvRows('"say ""hello""",rest')
    expect(rows[0][0]).toBe('say "hello"')
  })

  it("handles CRLF line endings", () => {
    const rows = parseCsvRows("a,b\r\nc,d")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(["a", "b"])
    expect(rows[1]).toEqual(["c", "d"])
  })

  it("handles empty fields", () => {
    const rows = parseCsvRows("a,,c")
    expect(rows[0]).toEqual(["a", "", "c"])
  })

  it("handles trailing newline", () => {
    const rows = parseCsvRows("a,b\nc,d\n")
    // Trailing newline creates an extra empty row — filter handled upstream
    expect(rows.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── parseCsvBilingual integration tests ────────────────────────────────────

describe("parseCsvBilingual", () => {
  it("parses 2-column CSV without header", () => {
    const csv = "Hello world,Bonjour monde\nGoodbye,Au revoir"
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].translated).toBe("Bonjour monde")
    expect(result[1].original).toBe("Goodbye")
    expect(result[1].translated).toBe("Au revoir")
    expect(result[0].type).toBe("text")
  })

  it("parses 2-column TSV without header", () => {
    const tsv = "Hello world\tBonjour monde\nGoodbye\tAu revoir"
    const result = parseCsvBilingual(tsv)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].translated).toBe("Bonjour monde")
  })

  it("skips header row when column names are recognized", () => {
    const csv = "source,target\nHello,Hola\nBye,Adiós"
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Hello")
    expect(result[0].translated).toBe("Hola")
  })

  it("skips header row with 'id,source,target' layout", () => {
    const csv = "id,source,target\ngreeting,Hello,Hola\nfarewell,Bye,Adiós"
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Hello")
    expect(result[0].context).toBe("greeting")
    expect(result[0].group).toBe("greeting")
  })

  it("handles 3-column CSV where col[0] looks like an id (no-header)", () => {
    const csv = "tu001,Source text,Target text\ntu002,Another source,Another target"
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Source text")
    expect(result[0].translated).toBe("Target text")
    expect(result[0].context).toBe("tu001")
  })

  it("skips rows with empty source", () => {
    const csv = "source,target\n,empty source\nreal source,real target"
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("real source")
  })

  it("handles quoted fields with embedded commas", () => {
    const csv = `"Hello, dear world","Bonjour, cher monde"\n"Bye","Au revoir"`
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Hello, dear world")
    expect(result[0].translated).toBe("Bonjour, cher monde")
  })

  it("handles quoted fields with embedded newlines", () => {
    const csv = `"Line 1\nLine 2","Ligne 1\nLigne 2"\nshort,court`
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Line 1\nLine 2")
    expect(result[0].translated).toBe("Ligne 1\nLigne 2")
  })

  it("handles doubled-quote escaping inside fields", () => {
    const csv = `"He said ""hello""","Il a dit ""bonjour"""`
    const result = parseCsvBilingual(csv)
    expect(result[0].original).toBe('He said "hello"')
    expect(result[0].translated).toBe('Il a dit "bonjour"')
  })

  it("assigns unique ids", () => {
    const csv = "a,b\nc,d"
    const result = parseCsvBilingual(csv)
    expect(result[0].id).not.toBe(result[1].id)
  })

  it("handles empty input", () => {
    expect(parseCsvBilingual("")).toHaveLength(0)
    expect(parseCsvBilingual("   ")).toHaveLength(0)
  })

  it("handles header-only input", () => {
    expect(parseCsvBilingual("source,target")).toHaveLength(0)
  })

  it("uses row number as context when no id column", () => {
    const csv = "Hello,Hola"
    const result = parseCsvBilingual(csv)
    expect(result[0].context).toBe("Row 1")
  })

  it("handles TSV with recognized header names", () => {
    const tsv = "source\ttarget\nHello\tHola"
    const result = parseCsvBilingual(tsv)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello")
    expect(result[0].translated).toBe("Hola")
  })

  it("handles alternative header names (original/translation)", () => {
    const csv = "original,translation\nHello world,Hola mundo"
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].translated).toBe("Hola mundo")
  })

  it("handles Windows CRLF line endings", () => {
    const csv = "source,target\r\nHello,Hola\r\nBye,Adiós"
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(2)
    expect(result[0].original).toBe("Hello")
    expect(result[1].original).toBe("Bye")
  })

  // ─── BOM edge cases ────────────────────────────────────────────────────

  it("strips leading UTF-8 BOM (U+FEFF) — Excel UTF-8 CSV export", () => {
    // Excel UTF-8 with BOM prepends U+FEFF to the file. After file.text() this
    // appears as the first character of the string and would corrupt the first
    // header cell if not stripped.
    const bom = "﻿"
    const csv = `${bom}source,target\nHello,Hola`
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello")
    expect(result[0].translated).toBe("Hola")
  })

  it("strips BOM from headerless CSV — first cell is not corrupted", () => {
    const bom = "﻿"
    const csv = `${bom}Hello world,Bonjour monde`
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].translated).toBe("Bonjour monde")
  })

  // ─── 4th column as context/notes ──────────────────────────────────────

  it("uses 4th column as context when header names it 'context'", () => {
    const csv = "source,target,id,context\nHello,Hola,greeting,Used on home screen"
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello")
    expect(result[0].translated).toBe("Hola")
    expect(result[0].context).toContain("Used on home screen")
  })

  it("uses 4th column as context when header names it 'note'", () => {
    const csv = "id,source,target,note\ntu1,Save,Enregistrer,Button in settings"
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(1)
    expect(result[0].context).toContain("Button in settings")
  })

  it("positional 4-column (id,src,tgt,ctx) — 4th col appended to context", () => {
    // No header: col[0]=id (no-spaces short), col[1]=src, col[2]=tgt, col[3]=ctx
    const csv = "tu001,Source text,Target text,Translator note here\ntu002,Other source,Other target,"
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(2)
    expect(result[0].context).toContain("Translator note here")
    // Empty 4th col → no note appended
    expect(result[1].context).toBe("tu002")
  })

  it("positional 3-column without id (src,tgt,ctx) — 3rd col is context", () => {
    // col[0] has spaces → not an id; col[0]=src, col[1]=tgt, col[2]=ctx
    const csv = "Hello world,Bonjour monde,Greeting used at login"
    const result = parseCsvBilingual(csv)
    expect(result).toHaveLength(1)
    expect(result[0].original).toBe("Hello world")
    expect(result[0].translated).toBe("Bonjour monde")
    expect(result[0].context).toContain("Greeting used at login")
  })
})
