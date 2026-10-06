/**
 * Biblica's import panel (AQU-1286).
 *
 * Lifted verbatim out of `src/components/ImportDialog.tsx`, where it was one of
 * fourteen inline panels, so that Biblica's UI lives with Biblica's code. The
 * dialog now reaches it through `register.ts` → `importScreen.panel`, a lazy
 * import, so this file and the IDML readers behind it load only when someone
 * actually opens the Biblica importer.
 *
 * Default-exported because `React.lazy` expects a module with a default export.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { useT } from "@/lib/i18n/I18nProvider"
import type { PartnerImportPanelProps } from "@/lib/partners/types"
import { importBiblicaStudyNotes, type BiblicaProgress } from "./import"
import type { BiblicaEdition } from "./editions"

/**
 * One tick-box option on the Biblica panel: the label doubles as the control's
 * accessible name, and the hint under it says what ticking the box changes.
 */
function BiblicaOption({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
        aria-label={label}
      />
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

function BiblicaPanel({
  projectId,
  username,
  sourceLanguage,
  targetLanguage,
  getToken,
  onImported,
}: PartnerImportPanelProps) {
  const t = useT()
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<BiblicaProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  // Off by default: each InDesign line stays one cell unless the translator opts in.
  const [splitSentences, setSplitSentences] = useState(false)
  // The four Biblica templates disagree about what a paragraph style means — a
  // study Bible marks its notes, the next two mark scripture instead, and an EBL
  // guide has no scripture to mark — and nothing in the package says which title
  // it is, so the person importing it does. One edition at a time, hence a single
  // value rather than a flag per title.
  const [edition, setEdition] = useState<BiblicaEdition>("study-notes")

  async function handleImport() {
    if (!file || importing) return
    setImporting(true)
    setError(null)
    setProgress({ phase: "parse" })
    try {
      const ref = await importBiblicaStudyNotes(
        file,
        {
          projectId,
          author: username,
          ...(sourceLanguage ? { sourceLanguage } : {}),
          ...(targetLanguage ? { targetLanguage } : {}),
          getToken,
        },
        setProgress,
        { splitSentences, edition },
      )
      await onImported(ref)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("importExport.errors.importFailed"))
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  function chooseEdition(next: BiblicaEdition, checked: boolean) {
    setEdition(checked ? next : "study-notes")
    setError(null)
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-xs text-muted-foreground">
        {edition === "treasure-hunt"
          ? t("importExport.biblica.descriptionTreasureHunt")
          : edition === "reach4life"
          ? t("importExport.biblica.descriptionReach4Life")
          : edition === "ebl"
          ? t("importExport.biblica.descriptionEbl")
          : t("importExport.biblica.description")}
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" nativeButton={false} render={<label className="cursor-pointer" />}>
          {file
            ? file.name
            : edition === "treasure-hunt" ? t("importExport.biblica.chooseFileTreasureHunt")
            : edition === "reach4life" ? t("importExport.biblica.chooseFileReach4Life")
            : edition === "ebl" ? t("importExport.biblica.chooseFileEbl")
            : t("importExport.biblica.chooseFile")}
          <input
            type="file"
            className="hidden"
            accept=".idml"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              setFile(f)
              setError(null)
            }}
            disabled={importing}
          />
        </Button>
        {file && !importing && (
          <p className="text-xs text-muted-foreground">
            {file.name} — {(file.size / 1024 / 1024).toFixed(2)} MB
          </p>
        )}
        {/* How finely to cut the text, which every edition answers the same way. */}
        <BiblicaOption
          label={t("importExport.biblica.splitSentencesLabel")}
          hint={t("importExport.biblica.splitSentencesHint")}
          checked={splitSentences}
          disabled={importing}
          onChange={setSplitSentences}
        />
      </div>
      {/* Which template to read the package with — a different question, and the
          three answers are alternatives, so they are grouped away from the cut
          setting above rather than sitting in one undifferentiated list. */}
      <fieldset className="flex flex-col gap-2 border-t border-border/60 pt-4">
        <legend className="sr-only">{t("importExport.biblica.editionQuestion")}</legend>
        <div className="flex flex-col gap-0.5">
          <span aria-hidden className="text-sm font-medium">
            {t("importExport.biblica.editionQuestion")}
          </span>
          <span className="text-xs text-muted-foreground">
            {t("importExport.biblica.editionQuestionHint")}
          </span>
        </div>
        <BiblicaOption
          label={t("importExport.biblica.treasureHuntLabel")}
          hint={t("importExport.biblica.treasureHuntHint")}
          checked={edition === "treasure-hunt"}
          disabled={importing}
          onChange={(checked) => chooseEdition("treasure-hunt", checked)}
        />
        <BiblicaOption
          label={t("importExport.biblica.reach4lifeLabel")}
          hint={t("importExport.biblica.reach4lifeHint")}
          checked={edition === "reach4life"}
          disabled={importing}
          onChange={(checked) => chooseEdition("reach4life", checked)}
        />
        <BiblicaOption
          label={t("importExport.biblica.eblLabel")}
          hint={t("importExport.biblica.eblHint")}
          checked={edition === "ebl"}
          disabled={importing}
          onChange={(checked) => chooseEdition("ebl", checked)}
        />
      </fieldset>
      {progress && (
        <div className="text-xs text-muted-foreground">
          {progress.phase === "parse" && (
            <p>
              {progress.idml?.total
                ? t("importExport.biblica.readingPackageWithProgress", {
                    completed: progress.idml.completed,
                    total: progress.idml.total,
                  })
                : t("importExport.biblica.readingPackage")}
            </p>
          )}
          {progress.phase === "save" && progress.cellsTotal && (
            <>
              <p>
                {t("importExport.tn.uploadingNotes", {
                  enqueued: (progress.cellsEnqueued ?? 0).toLocaleString(),
                  total: progress.cellsTotal.toLocaleString(),
                })}
              </p>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round(((progress.cellsEnqueued ?? 0) / progress.cellsTotal) * 100)}%` }}
                />
              </div>
              {progress.verseUnitCount ? (
                <p className="mt-1.5">
                  {t("importExport.biblica.paragraphsSkipped", { count: progress.verseUnitCount })}
                </p>
              ) : null}
            </>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button onClick={handleImport} disabled={!file || importing}>
          {importing ? t("importExport.action.importing") : t("nav.workspaceActions.import")}
        </Button>
      </div>
    </div>
  )
}

export default BiblicaPanel
