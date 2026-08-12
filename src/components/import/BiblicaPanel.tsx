import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { importBiblicaStudyNotes, type BiblicaProgress } from "@/lib/import"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import type { FileReference } from "@/lib/parsers/types"

interface BiblicaPanelProps {
  projectId: string
  username: string
  sourceLanguage?: string
  targetLanguage?: string
  getToken: (fileId: string) => Promise<string | null>
  onImported: (ref: FileReference) => void | Promise<void>
}

export function BiblicaPanel({
  projectId,
  username,
  sourceLanguage,
  targetLanguage,
  getToken,
  onImported,
}: BiblicaPanelProps) {
  const { locale } = useI18n()
  const t = useT()
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState<BiblicaProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  // Off by default: each InDesign line stays one cell unless the translator opts in.
  const [splitSentences, setSplitSentences] = useState(false)

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
        { splitSentences },
      )
      await onImported(ref)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("importExport.errors.importFailed"))
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-xs text-muted-foreground">{t("importExport.biblica.description")}</p>
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" nativeButton={false} render={<label className="cursor-pointer" />}>
          {file ? file.name : t("importExport.biblica.chooseFile")}
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
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 px-3 py-2 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={splitSentences}
            disabled={importing}
            onCheckedChange={(checked) => setSplitSentences(checked === true)}
            aria-label={t("importExport.biblica.splitSentencesLabel")}
          />
          <span className="flex flex-col gap-0.5">
            <span>{t("importExport.biblica.splitSentencesLabel")}</span>
            <span className="text-xs text-muted-foreground">
              {t("importExport.biblica.splitSentencesHint")}
            </span>
          </span>
        </label>
      </div>
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
                  enqueued: formatNumber(progress.cellsEnqueued ?? 0, locale),
                  total: formatNumber(progress.cellsTotal, locale),
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
                  {t("importExport.biblica.paragraphsSkipped", {
                    count: formatNumber(progress.verseUnitCount, locale),
                  })}
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
