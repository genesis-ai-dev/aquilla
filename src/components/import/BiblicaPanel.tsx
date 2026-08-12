import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { importBiblicaStudyNotes, type BiblicaProgress } from "@/lib/import"
import { useI18n } from "@/lib/i18n/I18nProvider"
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
      setError(err instanceof Error ? err.message : "Import failed")
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-xs text-muted-foreground">
        Upload the InDesign (.idml) package for a Biblica study Bible. Only the study
        notes are imported — the Bible text is skipped, because it comes from the
        published scripture files rather than being retyped here. Each note keeps its
        InDesign formatting locked, and the notes carry the book and chapter range they
        belong to so they stay in step with the passage. Lists that InDesign holds in a
        single paragraph — cross-references, glossaries, outlines — always arrive as one
        cell per line. Optionally, longer note blocks can also be split into one cell per
        sentence; export puts each block back together as InDesign set it.
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="outline" size="sm" nativeButton={false} render={<label className="cursor-pointer" />}>
          {file ? file.name : "Choose study Bible IDML file"}
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
            aria-label="Split long notes into one cell per sentence"
          />
          <span className="flex flex-col gap-0.5">
            <span>Split long notes into one cell per sentence</span>
            <span className="text-xs text-muted-foreground">
              Leave unchecked to import each note line as one larger cell. Lists still
              split per line either way.
            </span>
          </span>
        </label>
      </div>
      {progress && (
        <div className="text-xs text-muted-foreground">
          {progress.phase === "parse" && (
            <p>
              Reading the InDesign package…
              {progress.idml?.total
                ? ` (${progress.idml.completed} / ${progress.idml.total})`
                : ""}
            </p>
          )}
          {progress.phase === "save" && progress.cellsTotal && (
            <>
              <p>
                Uploading: {formatNumber(progress.cellsEnqueued ?? 0, locale)} / {formatNumber(progress.cellsTotal, locale)} notes
              </p>
              <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round(((progress.cellsEnqueued ?? 0) / progress.cellsTotal) * 100)}%` }}
                />
              </div>
              {progress.verseUnitCount ? (
                <p className="mt-1.5">
                  {formatNumber(progress.verseUnitCount, locale)} scripture paragraphs skipped.
                </p>
              ) : null}
            </>
          )}
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button onClick={handleImport} disabled={!file || importing}>
          {importing ? "Importing…" : "Import"}
        </Button>
      </div>
    </div>
  )
}
