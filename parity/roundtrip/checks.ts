/**
 * FROZEN (F7) — round-trip fidelity checks. Do not modify after Phase 0.
 * If a genuine bug is found, log it in ITERATION_LOG.md, mark affected rows
 * disputed, and leave the code alone — a human resolves it.
 *
 * External validators outrank self-report (F4):
 *   - XLIFF 1.2/2.0 → xmllint --schema against the official OASIS XSDs
 *   - TMX → xmllint --dtdvalid against the official TMX 1.4 DTD
 *   - OOXML (docx/pptx) → python3 stdlib zipfile+minidom structural diff
 *     (independent of the jszip/DOMParser stack the exporters use)
 *   - JSON → python3 json deep-equality
 *   - HTML → xmllint --html parse
 * Re-parse comparisons use Aquilla's own parsers ONLY for text-content
 * equality (import symmetry), never as the sole validity signal.
 */
import { execFileSync } from "node:child_process"
import { writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMAS = join(here, "..", "schemas")

export type Family =
  | "xliff12"
  | "xliff20"
  | "tmx"
  | "ooxml-docx"
  | "ooxml-pptx"
  | "subtitle"
  | "json"
  | "html"
  | "text"

export interface FormatSpec {
  kind: "roundtrip" | "import-only"
  family: Family
}

/** FROZEN mapping: corpus format → fidelity requirements. */
export const FORMAT_SPECS: Record<string, FormatSpec> = {
  xliff12: { kind: "roundtrip", family: "xliff12" },
  xliff20: { kind: "roundtrip", family: "xliff20" },
  tmx: { kind: "roundtrip", family: "tmx" },
  txt: { kind: "roundtrip", family: "text" },
  csv: { kind: "roundtrip", family: "text" },
  tsv: { kind: "roundtrip", family: "text" },
  srt: { kind: "roundtrip", family: "subtitle" },
  vtt: { kind: "roundtrip", family: "subtitle" },
  sbv: { kind: "import-only", family: "subtitle" },
  md: { kind: "roundtrip", family: "text" },
  html: { kind: "roundtrip", family: "html" },
  json: { kind: "roundtrip", family: "json" },
  po: { kind: "roundtrip", family: "text" },
  properties: { kind: "roundtrip", family: "text" },
  docx: { kind: "roundtrip", family: "ooxml-docx" },
  pptx: { kind: "roundtrip", family: "ooxml-pptx" },
  xlsx: { kind: "import-only", family: "text" },
}

export interface CheckFailure {
  check: string
  detail: string
}

const run = (cmd: string, args: string[]): { ok: boolean; out: string } => {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    return { ok: true, out }
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string; message?: string }
    return { ok: false, out: (err.stderr || err.stdout || err.message || "").slice(0, 2000) }
  }
}

const withTemp = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "parity-rt-"))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const normalizeText = (s: string): string => s.replace(/\s+/g, " ").trim()

export const multisetEqual = (a: string[], b: string[]): { ok: boolean; detail: string } => {
  const count = (xs: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
    return m
  }
  const ma = count(a.map(normalizeText).filter((s) => s.length > 0))
  const mb = count(b.map(normalizeText).filter((s) => s.length > 0))
  if (ma.size !== mb.size) return { ok: false, detail: `distinct ${ma.size} vs ${mb.size}` }
  for (const [k, v] of ma) {
    if (mb.get(k) !== v) return { ok: false, detail: `count mismatch for a segment (${v} vs ${mb.get(k) ?? 0})` }
  }
  return { ok: true, detail: "" }
}

/** Extract all subtitle timecodes as milliseconds (handles HH:MM:SS[.,]mmm and MM:SS.mmm). */
export const extractTimecodesMs = (content: string): number[] => {
  const out: number[] = []
  const re = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const h = m[1] ? Number(m[1]) : 0
    out.push(((h * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]))
  }
  return out.sort((x, y) => x - y)
}

export const validateXliff12 = (bytes: Uint8Array): CheckFailure | null =>
  withTemp((dir) => {
    const f = join(dir, "out.xlf")
    writeFileSync(f, bytes)
    const r = run("xmllint", ["--noout", "--schema", join(SCHEMAS, "xliff-core-1.2-transitional.xsd"), f])
    return r.ok ? null : { check: "xsd-xliff12", detail: r.out }
  })

export const validateXliff20 = (bytes: Uint8Array): CheckFailure | null =>
  withTemp((dir) => {
    const f = join(dir, "out.xlf")
    writeFileSync(f, bytes)
    const r = run("xmllint", ["--noout", "--schema", join(SCHEMAS, "xliff_core_2.0.xsd"), f])
    return r.ok ? null : { check: "xsd-xliff20", detail: r.out }
  })

export const validateTmx = (bytes: Uint8Array): CheckFailure | null =>
  withTemp((dir) => {
    const f = join(dir, "out.tmx")
    writeFileSync(f, bytes)
    const r = run("xmllint", ["--noout", "--dtdvalid", join(SCHEMAS, "tmx14.dtd"), f])
    return r.ok ? null : { check: "dtd-tmx", detail: r.out }
  })

export const validateHtml = (bytes: Uint8Array): CheckFailure | null =>
  withTemp((dir) => {
    const f = join(dir, "out.html")
    writeFileSync(f, bytes)
    // xmllint --html is lenient; we require it to produce a parse without fatal errors.
    const r = run("xmllint", ["--html", "--noout", "--nowarning", f])
    return r.ok ? null : { check: "html-parse", detail: r.out }
  })

export const validateOoxml = (
  original: Uint8Array,
  exported: Uint8Array,
  kind: "docx" | "pptx",
): CheckFailure | null =>
  withTemp((dir) => {
    const o = join(dir, "orig.bin")
    const x = join(dir, "export.bin")
    writeFileSync(o, original)
    writeFileSync(x, exported)
    const r = run("python3", [join(here, "ooxml-check.py"), o, x, kind])
    if (!r.ok) return { check: "ooxml-tool", detail: r.out }
    const verdict = JSON.parse(r.out) as { ok: boolean; reason?: string }
    return verdict.ok ? null : { check: "ooxml-structure", detail: verdict.reason ?? "unknown" }
  })

export const validateJsonEqual = (original: Uint8Array, exported: Uint8Array): CheckFailure | null =>
  withTemp((dir) => {
    const o = join(dir, "orig.json")
    const x = join(dir, "export.json")
    writeFileSync(o, original)
    writeFileSync(x, exported)
    const r = run("python3", [
      "-c",
      `import json,sys
a=json.load(open(sys.argv[1],encoding="utf-8")); b=json.load(open(sys.argv[2],encoding="utf-8"))
print(json.dumps({"ok": a==b}))`,
      o,
      x,
    ])
    if (!r.ok) return { check: "json-tool", detail: r.out }
    const verdict = JSON.parse(r.out) as { ok: boolean }
    return verdict.ok ? null : { check: "json-equality", detail: "copy-source export is not deep-equal to original" }
  })
