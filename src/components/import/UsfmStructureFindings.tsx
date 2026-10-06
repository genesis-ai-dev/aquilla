import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type {
  UsfmStructureCode,
  UsfmStructureFinding,
} from "@/lib/parsers/usfm-structure-check"
import { Badge } from "@/components/ui/badge"

/**
 * The Paratext-parity "Chapter/Verse Numbers" + "Markers" findings for one
 * imported USFM file (AQU-1731), shown before commit.
 *
 * `checkUsfmStructure` returns codes and refs, never sentences — the same
 * division `rule-engine.ts` uses for its reason codes — so the English/
 * localized wording is resolved HERE, at the render site, off `FINDING_KEY`.
 * That mapping is a `Record<UsfmStructureCode, …>`, so adding a code to the
 * checker without a message is a compile error rather than a blank bullet.
 */
const FINDING_KEY: Record<UsfmStructureCode, MessageKey> = {
  "chapter-duplicate": "importExport.usfmStructure.chapterDuplicate",
  "chapter-missing": "importExport.usfmStructure.chapterMissing",
  "chapter-out-of-order": "importExport.usfmStructure.chapterOutOfOrder",
  "chapter-invalid": "importExport.usfmStructure.chapterInvalid",
  "verse-duplicate": "importExport.usfmStructure.verseDuplicate",
  "verse-missing": "importExport.usfmStructure.verseMissing",
  "verse-out-of-order": "importExport.usfmStructure.verseOutOfOrder",
  "verse-invalid": "importExport.usfmStructure.verseInvalid",
  "verse-outside-chapter": "importExport.usfmStructure.verseOutsideChapter",
  "marker-unknown": "importExport.usfmStructure.markerUnknown",
  "marker-unclosed": "importExport.usfmStructure.markerUnclosed",
  "marker-unopened": "importExport.usfmStructure.markerUnopened",
  "marker-level-mixed": "importExport.usfmStructure.markerLevelMixed",
  "marker-after-chapter": "importExport.usfmStructure.markerAfterChapter",
}

/** A badly broken book can produce thousands of findings; the preview is a
 *  "should I import this?" signal, not the full report, so it lists the first
 *  few and counts the rest. */
const LIST_LIMIT = 12

export function UsfmStructureFindings({ findings }: { findings: UsfmStructureFinding[] }) {
  const t = useT()
  if (findings.length === 0) return null

  const errors = findings.filter((f) => f.severity === "error").length
  const shown = findings.slice(0, LIST_LIMIT)

  return (
    <div
      className="mb-3 flex flex-col gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-xs"
      data-testid="usfm-structure-findings"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t("importExport.usfmStructure.heading")}</span>
        <Badge variant={errors > 0 ? "destructive" : "outline"}>{findings.length}</Badge>
      </div>
      <ul className="flex list-disc flex-col gap-1 ps-4 text-muted-foreground">
        {shown.map((f, index) => (
          <li key={`${f.code}-${f.offset}-${index}`}>
            {f.ref ? <span className="font-mono text-foreground/70">{f.ref}</span> : null}
            {f.ref ? " — " : null}
            {t(FINDING_KEY[f.code], { detail: f.detail })}
          </li>
        ))}
        {findings.length > shown.length && (
          <li className="list-none text-muted-foreground/70">
            {t("importExport.usfmStructure.more", { count: findings.length - shown.length })}
          </li>
        )}
      </ul>
    </div>
  )
}
