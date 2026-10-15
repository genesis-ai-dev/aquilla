/**
 * IDML adapter: InDesign Markup Language packages.
 */
import { sha256, shortHash } from "../../core/hash.ts"
import { parseTagged, tokenIds } from "../../core/tagged.ts"
import type { ContentGraph, ContentUnit, Diagnostic, ValidationResult } from "../../core/types.ts"
import type { ContentAdapter, LayoutFinding, MergeResult, RenderResult } from "../adapter.ts"
import { bytesEqual, entryData, entryText, readZip, rewriteZip, ZipError } from "../zip.ts"
import { parseXml, XmlError } from "../xml.ts"
import { estimateFit, framesOf, paragraphStyleMetrics } from "./layout.ts"
import type { StoryText } from "./layout.ts"
import { masterStoryIds, memberText, openIdml } from "./package.ts"
import type { IdmlPackage } from "./package.ts"
import { extractStory, renderStory, storySkeleton } from "./story.ts"
import type { ExtractedStory } from "./story.ts"

const enc = new TextEncoder()

interface Extraction {
  readonly pkg: IdmlPackage
  readonly stories: Map<string, { xml: string; extracted: ExtractedStory }>
  readonly diagnostics: Diagnostic[]
}

const extractAll = (bytes: Uint8Array): Extraction => {
  const pkg = openIdml(bytes)
  const masters = masterStoryIds(pkg)
  const stories = new Map<string, { xml: string; extracted: ExtractedStory }>()
  const diagnostics: Diagnostic[] = []
  for (const member of pkg.stories) {
    const xml = memberText(pkg, member)
    const extracted = extractStory(member, xml, (id) => (masters.has(id) ? "master" : "paragraph"))
    stories.set(member, { xml, extracted })
    diagnostics.push(...extracted.diagnostics)
  }
  return { pkg, stories, diagnostics }
}

export const idmlAdapter: ContentAdapter = {
  format: "idml",
  extensions: [".idml"],

  extract(bytes: Uint8Array, docId: string): ContentGraph {
    const { stories, diagnostics } = extractAll(bytes)
    const units: ContentUnit[] = []
    for (const { extracted } of stories.values()) for (const su of extracted.units) units.push(su.unit)
    return { docId, format: "idml", revision: shortHash(bytes), units, diagnostics }
  },

  render(source: Uint8Array, translations: ReadonlyMap<string, string>): RenderResult {
    const { pkg, stories } = extractAll(source)
    const replacements = new Map<string, Uint8Array>()
    const diagnostics: Diagnostic[] = []
    for (const [member, { xml, extracted }] of stories) {
      const out = renderStory(member, xml, extracted, translations)
      diagnostics.push(...out.diagnostics)
      if (out.xml !== xml) replacements.set(member, enc.encode(out.xml))
    }
    return { bytes: rewriteZip(pkg.archive, replacements), diagnostics }
  },

  validate(source: Uint8Array, output: Uint8Array): ValidationResult {
    const diagnostics: Diagnostic[] = []
    const err = (code: string, message: string, path?: string): void => {
      diagnostics.push({ code, severity: "error", message, ...(path ? { path } : {}) })
    }
    let src: Extraction
    let out: Extraction
    try {
      src = extractAll(source)
    } catch (e) {
      err("SOURCE_UNREADABLE", (e as Error).message)
      return { ok: false, diagnostics }
    }
    try {
      out = extractAll(output)
    } catch (e) {
      err(e instanceof ZipError || e instanceof XmlError ? e.code : "OUTPUT_UNREADABLE", (e as Error).message)
      return { ok: false, diagnostics }
    }
    // Package structure: same members, same order; non-story members byte-identical.
    const sNames = src.pkg.archive.entries.map((e) => e.name)
    const oNames = out.pkg.archive.entries.map((e) => e.name)
    if (sNames.join("\n") !== oNames.join("\n")) err("MEMBERS_CHANGED", "package member list or order changed")
    const storySet = new Set(src.pkg.stories)
    for (const e of out.pkg.archive.entries) {
      const s = src.pkg.byName.get(e.name)
      if (!s) continue
      if (!storySet.has(e.name)) {
        if (!bytesEqual(entryData(s), entryData(e))) err("NON_STORY_MEMBER_CHANGED", `${e.name} changed but holds no translatable text`, e.name)
        continue
      }
      // Every XML member must still parse.
      try {
        parseXml(entryText(e))
      } catch (x) {
        err("MALFORMED_XML", (x as Error).message, e.name)
      }
    }
    // Story skeletons (text removed) must be identical, unit counts equal, tokens preserved.
    for (const [member, s] of src.stories) {
      const o = out.stories.get(member)
      if (!o) {
        err("MISSING_STORY", `${member} missing from output`, member)
        continue
      }
      if (storySkeleton(s.xml, s.extracted) !== storySkeleton(o.xml, o.extracted)) {
        err("STRUCTURE_CHANGED", `${member}: markup outside text slots changed`, member)
      }
      // Paragraph count can only drop if a translation is empty (no letters) — flag it.
      if (s.extracted.units.length !== o.extracted.units.length) {
        diagnostics.push({
          code: "UNIT_COUNT_CHANGED",
          severity: "warning",
          message: `${member}: ${s.extracted.units.length} translatable paragraphs in source, ${o.extracted.units.length} in output`,
          path: member,
        })
      }
    }
    for (const [member, s] of src.stories) {
      const o = out.stories.get(member)
      if (!o || o.extracted.units.length !== s.extracted.units.length) continue
      s.extracted.units.forEach((su, i) => {
        const ou = o.extracted.units[i]!
        if (tokenIds(su.unit.tagged).length !== tokenIds(ou.unit.tagged).length) {
          err("TOKENS_CHANGED", `${su.unit.structuralPath}: protected inline objects changed`, member)
        }
      })
    }
    return { ok: !diagnostics.some((d) => d.severity === "error"), diagnostics }
  },

  merge3(base: Uint8Array, theirs: Uint8Array, ours: Uint8Array): MergeResult {
    // Member-level three-way merge. A member changed only by the person (theirs)
    // keeps their bytes; a member changed only by us takes ours; a member
    // changed by both is a conflict — except stories where *they* changed only
    // text (already captured as human edits upstream) or *we* changed only
    // text and their story skeleton still matches the base skeleton.
    const b = readZip(base)
    const t = readZip(theirs)
    const o = readZip(ours)
    const conflicts: string[] = []
    const takenOurs: string[] = []
    const bMap = new Map(b.entries.map((e) => [e.name, e]))
    const oMap = new Map(o.entries.map((e) => [e.name, e]))
    const replacements = new Map<string, Uint8Array>()
    for (const te of t.entries) {
      const be = bMap.get(te.name)
      const oe = oMap.get(te.name)
      if (!be || !oe) continue
      const bd = entryData(be)
      const td = entryData(te)
      const od = entryData(oe)
      const theyChanged = !bytesEqual(bd, td)
      const weChanged = !bytesEqual(bd, od)
      if (!weChanged) continue
      if (!theyChanged) {
        replacements.set(te.name, od)
        takenOurs.push(te.name)
        continue
      }
      if (bytesEqual(td, od)) continue
      if (te.name.startsWith("Stories/")) {
        const dec = new TextDecoder()
        const [bx, tx] = [dec.decode(bd), dec.decode(td)]
        try {
          const be2 = extractStory(te.name, bx)
          const te2 = extractStory(te.name, tx)
          if (storySkeleton(tx, te2) === storySkeleton(bx, be2)) {
            // The person changed only text in this story. Those edits were
            // captured upstream as human decisions and are already in ours,
            // so ours (which may also carry new source structure) is complete.
            replacements.set(te.name, od)
            takenOurs.push(te.name)
            continue
          }
        } catch {
          /* fall through to conflict */
        }
      }
      conflicts.push(te.name)
    }
    return { bytes: rewriteZip(t, replacements), conflicts, takenOurs }
  },

  layout(source: Uint8Array, output: Uint8Array): LayoutFinding[] {
    const s = extractAll(source)
    const o = extractAll(output)
    const frames = framesOf(s.pkg)
    const metrics = paragraphStyleMetrics(s.pkg)
    const toText = (x: Extraction): StoryText[] =>
      [...x.stories.values()].map(({ extracted }) => ({
        story: extracted.storyId,
        paragraphs: extracted.units
          .filter((su) => su.unit.kind !== "table-cell" && su.unit.kind !== "footnote" && su.unit.kind !== "endnote")
          .map((su) => {
            const style = String(su.unit.meta?.paragraphStyle ?? "")
            const m = metrics.get(style) ?? { size: 12, leading: 14.4 }
            const local = Number(su.unit.meta?.pointSize)
            const size = local > 0 ? local : m.size
            return { text: su.unit.plain, size, leading: local > 0 ? local * 1.2 : m.leading }
          }),
      }))
    return estimateFit(frames, toText(s), toText(o))
  },
}

/** For tests and reports: the text of every unit, in order, keyed by structural path. */
export const idmlTexts = (bytes: Uint8Array): Map<string, string> => {
  const g = idmlAdapter.extract(bytes, "x")
  return new Map(g.units.map((u) => [u.structuralPath, u.tagged]))
}

export const idmlDigest = (bytes: Uint8Array): string => sha256(bytes)

/** Re-export for consumers that only need plain text. */
export const plainPieces = (tagged: string): string[] => parseTagged(tagged).flatMap((p) => (p.kind === "text" ? [p.text] : []))
