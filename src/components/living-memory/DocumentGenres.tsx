/**
 * Document genres — per-file genre assignment on the Living Memory →
 * Translation quality pane (AQU-934 phase 3b).
 *
 * A genre-scoped style rule ("in poetry, keep parallel lines apart") reaches a
 * cell only when its file has a genre coordinate. Scripture files derive one
 * from their book code; everything else had none, and a book could not be
 * reclassified. Each row here shows the genre in force and where it came from
 * — derived from the book, or assigned by a person — with a picker that
 * overrides it and a reset that hands the file back to the derived value.
 *
 * Presentational by contract: files, the stored assignments and the save
 * callback all arrive as props from the page-level `useProjectSettings`
 * instance (panes must not open a second one — see LivingMemoryPage's header).
 * Suggestions are model output, so they are staged for confirmation and only
 * written on an explicit save — the same human gate as extracted style rules.
 */

import { useState } from "react"
import { AlertTriangle, RotateCcw, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import {
  describeFileGenre,
  FILE_GENRES,
  mergeFileGenres,
  normalizeFileGenre,
  setFileGenre,
  type FileGenre,
} from "@/lib/rules/file-genre"
import { RoleLockTooltip } from "./AuthoredEntriesSection"

const GENRE_LABEL_KEY: Record<FileGenre, MessageKey> = {
  law: "terminology.livingMemory.genres.name.law",
  history: "terminology.livingMemory.genres.name.history",
  wisdom: "terminology.livingMemory.genres.name.wisdom",
  poetry: "terminology.livingMemory.genres.name.poetry",
  prophecy: "terminology.livingMemory.genres.name.prophecy",
  gospel: "terminology.livingMemory.genres.name.gospel",
  epistle: "terminology.livingMemory.genres.name.epistle",
  apocalyptic: "terminology.livingMemory.genres.name.apocalyptic",
  narrative: "terminology.livingMemory.genres.name.narrative",
  teaching: "terminology.livingMemory.genres.name.teaching",
  dialogue: "terminology.livingMemory.genres.name.dialogue",
  reference: "terminology.livingMemory.genres.name.reference",
}

/** The file fields genre assignment needs — a structural subset of FileReference. */
export interface GenreFile {
  id: string
  name: string
  /** USFM book code when the file is a scripture book; drives the derived genre. */
  bookCode?: string
  /** Optional excerpt for the classifier. Absent ⇒ it judges by name alone. */
  sample?: string
}

interface DocumentGenresProps {
  files: readonly GenreFile[]
  /** `ProjectWideSettings.fileGenres` as stored (fileId → genre id). */
  assignments: Record<string, string> | undefined
  canEdit: boolean
  reasonCannotEdit: "offline" | "role" | null
  /** Receives the FULL replacement map — the settings key is written wholesale. */
  onSave: (next: Record<string, string>) => void | Promise<unknown>
  /** Classifies the files it is handed. Omitted ⇒ the suggest action is hidden
   *  (no model configured for this project). */
  onSuggest?: (files: readonly GenreFile[]) => Promise<Record<string, FileGenre>>
}

export function DocumentGenres({
  files,
  assignments,
  canEdit,
  reasonCannotEdit,
  onSave,
  onSuggest,
}: DocumentGenresProps) {
  const t = useT()
  const [suggestions, setSuggestions] = useState<Record<string, FileGenre> | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const genreItems = Object.fromEntries(
    FILE_GENRES.map((genre) => [genre, t(GENRE_LABEL_KEY[genre])]),
  )

  async function runSuggest() {
    if (!onSuggest) return
    // Only files without an explicit assignment — a human decision is never
    // re-litigated by the model.
    const unassigned = files.filter((file) => !normalizeFileGenre(assignments?.[file.id]))
    setRunning(true)
    setError(null)
    setSuggestions(null)
    try {
      setSuggestions(await onSuggest(unassigned))
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const suggested = suggestions
    ? files.filter((file) => suggestions[file.id] !== undefined)
    : []

  return (
    <section aria-label={t("terminology.livingMemory.genres.title")}>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="flex-1 text-xs font-semibold text-muted-foreground">
          {t("terminology.livingMemory.genres.title")}
        </h2>
        {canEdit && onSuggest ? (
          <Button
            variant="ghost"
            className="h-6 gap-1 px-2 text-xs"
            disabled={running || files.length === 0}
            onClick={() => { void runSuggest() }}
          >
            <Sparkles className="h-3 w-3" aria-hidden="true" />
            {t("terminology.livingMemory.genres.suggestButton")}
          </Button>
        ) : null}
        {canEdit ? null : <RoleLockTooltip reason={reasonCannotEdit} />}
      </div>

      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        {t("terminology.livingMemory.genres.description")}
      </p>

      {canEdit && !onSuggest ? (
        <p className="mb-3 text-xs text-muted-foreground/70">
          {t("terminology.livingMemory.genres.suggestNeedsModel")}
        </p>
      ) : null}

      {running ? (
        <p className="mb-3 text-xs text-muted-foreground" role="status">
          {t("terminology.livingMemory.genres.suggesting")}
        </p>
      ) : null}

      {error ? (
        <div
          className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{t("terminology.livingMemory.genres.suggestFailed", { message: error })}</span>
        </div>
      ) : null}

      {suggestions ? (
        <div className="mb-3 flex flex-col gap-2 rounded-lg border border-border/60 p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            {t("terminology.livingMemory.genres.suggestHeading")}
          </h3>
          {suggested.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 italic">
              {t("terminology.livingMemory.genres.suggestNone")}
            </p>
          ) : (
            <>
              <ul className="flex flex-col gap-1">
                {suggested.map((file) => (
                  <li key={file.id} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate">{file.name}</span>
                    <Badge variant="outline">
                      {t(GENRE_LABEL_KEY[suggestions[file.id]])}
                    </Badge>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground/70">
                {t("terminology.livingMemory.genres.suggestHint")}
              </p>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSuggestions(null)}>
              {t("common.discard")}
            </Button>
            {suggested.length > 0 ? (
              <Button
                onClick={() => {
                  void onSave(mergeFileGenres(assignments, suggestions))
                  setSuggestions(null)
                }}
              >
                {t("common.save")}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {files.length === 0 ? (
        <p className="text-xs text-muted-foreground/60 italic">
          {t("terminology.livingMemory.genres.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {files.map((file) => {
            const resolved = describeFileGenre(file.id, file.bookCode, assignments)
            return (
              <li
                key={file.id}
                className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{file.name}</span>
                <Badge variant={resolved.source === "assigned" ? "outline" : "ghost"}>
                  {resolved.source === "assigned"
                    ? t("terminology.livingMemory.styleRules.assignedBy.human")
                    : resolved.source === "derived"
                      ? t("terminology.livingMemory.genres.derived")
                      : t("terminology.livingMemory.genres.unclassified")}
                </Badge>
                <Select
                  items={genreItems}
                  value={resolved.genre ?? ""}
                  disabled={!canEdit}
                  onValueChange={(value) => {
                    const genre = normalizeFileGenre(value)
                    if (genre) void onSave(setFileGenre(assignments, file.id, genre))
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={t("terminology.livingMemory.genres.pickerAria", {
                      file: file.name,
                    })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {FILE_GENRES.map((genre) => (
                        <SelectItem key={genre} value={genre}>
                          {t(GENRE_LABEL_KEY[genre])}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  disabled={!canEdit || resolved.source !== "assigned"}
                  onClick={() => { void onSave(setFileGenre(assignments, file.id, null)) }}
                  aria-label={t("terminology.livingMemory.genres.resetAria", {
                    file: file.name,
                  })}
                >
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
