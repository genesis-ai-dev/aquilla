// Floating action bar that appears whenever the user has multi-selected
// cells. Surfaces bulk Translate / Validate / Generate Audio / Both.
//
// Synth uses the project's default voice; users can also drag a voice
// chip from the VoiceBar onto any selected cell to synth with that voice.

import { useCallback, useEffect, useMemo, useState } from "react"
import { CheckCheck, Languages, Loader2, Sparkles, Wand2, X } from "lucide-react"
import * as Y from "yjs"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { clearSelection, MAX_SELECTED, useSelectedIds } from "@/lib/audio/selection"
import {
  synthAsOneTake, synthEach, translateMissing,
  translateThenSynthAsOneTake,
} from "@/lib/audio/bulk-selected"
import { resolveVoice } from "@/lib/audio/voices"
import { toggleCellValidation } from "@/hooks/useCellHistory"

interface Props {
  project: ProjectRecord
  cells: CellData[]
  doc: Y.Doc
  session: FrontierSession | null
  username: string
  completeSingle?: (cell: CellData) => Promise<void> | void
  // Segmented batch translation. When provided, "Translate" sends the whole
  // selection as one <vN>-framed call instead of falling back to N
  // per-cell calls — much higher quality for sequential passages.
  completeBatch?: (cells: CellData[]) => Promise<void> | void
}

type Running =
  | { kind: "idle" }
  | { kind: "translate" }
  | { kind: "validate" }
  | { kind: "synth" }
  | { kind: "translate-synth" }

export function SelectionBar({ project, cells, doc, session, username, completeSingle, completeBatch }: Props) {
  const selected = useSelectedIds()
  const [running, setRunning] = useState<Running>({ kind: "idle" })

  useEffect(() => {
    if (selected.size === 0) return
    const onKey = (e: KeyboardEvent) => {
      // Don't steal Esc when the user is typing/editing — those handlers run
      // first and clear focus naturally. Only act when no editable element
      // is focused.
      if (e.key !== "Escape") return
      const ae = document.activeElement
      const editing = ae instanceof HTMLElement &&
        (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")
      if (editing) return
      clearSelection()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selected.size])

  const selectedCells = useMemo(() => {
    const wanted = selected
    return cells.filter((c) => wanted.has(c.id)).slice(0, MAX_SELECTED)
  }, [cells, selected])

  const missingCount = useMemo(
    () => selectedCells.filter((c) => !c.translated.trim() && c.original?.trim()).length,
    [selectedCells],
  )
  const validatableCount = useMemo(
    () => selectedCells.filter(
      (c) => c.translated.trim() && !c.activeValidators.includes(username),
    ).length,
    [selectedCells, username],
  )
  const allHaveTranslation = selectedCells.length > 0 && selectedCells.every((c) => c.translated.trim())
  const isGitProject = project.origin?.kind === "git"
  const isBusy = running.kind !== "idle"

  const onTranslate = useCallback(async () => {
    if (isBusy) return
    setRunning({ kind: "translate" })
    try {
      // Prefer the segmented batch path when available — it sends the whole
      // selection as one <vN>-framed prompt, which translates significantly
      // better than the same verses in isolation. Fall back to per-cell only
      // when the segmented path isn't wired (e.g. legacy callers).
      const missing = selectedCells.filter(
        (c) => !c.translated.trim() && c.original?.trim(),
      )
      if (missing.length > 0 && completeBatch) {
        await completeBatch(missing)
      } else {
        await translateMissing({
          cells: selectedCells, doc, project, session, username, completeSingle,
        })
      }
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, doc, project, session, username, completeSingle, completeBatch, isBusy])

  const onValidate = useCallback(() => {
    if (isBusy) return
    if (validatableCount === 0) return
    setRunning({ kind: "validate" })
    try {
      for (const cell of selectedCells) {
        if (!cell.translated.trim()) continue
        if (cell.activeValidators.includes(username)) continue
        toggleCellValidation(doc, cell.id, username, true)
      }
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, doc, username, validatableCount, isBusy])

  const onSynth = useCallback(async () => {
    if (isBusy) return
    const voiceId = resolveVoice(project.ttsSettings, undefined).id
    const isMulti = selectedCells.length > 1
    setRunning({ kind: "synth" })
    try {
      let result: { blob: Blob } | null = null
      if (missingCount > 0 && completeSingle) {
        // User asked for voice but some cells lack translations — translate
        // missing first, then run the (possibly group) synth.
        setRunning({ kind: "translate-synth" })
        if (isMulti) {
          result = await translateThenSynthAsOneTake({
            cells: selectedCells, doc, project, session, username, completeSingle, voiceId,
          })
        } else {
          // Single cell: per-cell path keeps existing behavior + auto-play
          // already lives in the drop handler. We don't auto-play from the
          // bar for single-cell synth here (rare path; user can hit speaker).
          await synthEach({
            cells: selectedCells, doc, project, session, username, voiceId,
          })
        }
      } else if (isMulti) {
        result = await synthAsOneTake({
          cells: selectedCells, doc, project, session, username, voiceId,
        })
      } else {
        await synthEach({
          cells: selectedCells, doc, project, session, username, voiceId,
        })
      }
      // Autoplay the take so the user hears the result as soon as it lands.
      if (result?.blob) void playTakePreview(result.blob)
    } catch (e) {
      console.warn("[selection-bar] synth failed", e)
    } finally {
      setRunning({ kind: "idle" })
    }
  }, [selectedCells, doc, project, session, username, completeSingle, missingCount, isBusy])

  if (selectedCells.length === 0) return null

  const isMulti = selectedCells.length > 1
  const synthLabel =
    running.kind === "translate-synth" ? "Translating + speaking…" :
    running.kind === "synth" ? "Speaking…" :
    missingCount > 0 ? "Translate + speak" :
    "Speak"

  return (
    <div
      className={cn(
        "pointer-events-auto fixed left-1/2 z-40 flex -translate-x-1/2 items-center gap-2",
        "bottom-4 rounded-full border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur",
        "supports-[backdrop-filter]:bg-background/80",
      )}
      role="toolbar"
      aria-label="Selection actions"
    >
      <span className="font-medium">
        {selectedCells.length} selected
        {missingCount > 0 && (
          <span className="ml-1 text-muted-foreground">
            ({missingCount} need translation)
          </span>
        )}
      </span>
      <div className="h-4 w-px bg-border" />
      <Button
        type="button"
        size="sm"
        variant="default"
        onClick={onTranslate}
        disabled={isBusy || missingCount === 0 || !completeSingle}
        title={
          !completeSingle ? "Translation isn't configured for this project" :
          missingCount === 0 ? "All selected cells already have translations" :
          `Translate ${missingCount} missing`
        }
      >
        {running.kind === "translate" ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Languages className="mr-1 h-3.5 w-3.5" />
        )}
        Translate
        {missingCount > 0 && allHaveTranslation === false && (
          <span className="ml-1 rounded-full bg-primary-foreground/20 px-1.5 py-0.5 tabular-nums text-primary-foreground">
            {missingCount}
          </span>
        )}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onValidate}
        disabled={isBusy || validatableCount === 0}
        title={
          validatableCount === 0
            ? "Nothing to validate — selected cells are empty or already validated by you"
            : `Validate ${validatableCount} cell${validatableCount === 1 ? "" : "s"}`
        }
      >
        {running.kind === "validate" ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <CheckCheck className="mr-1 h-3.5 w-3.5" />
        )}
        Validate
        {validatableCount > 0 && (
          <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">
            {validatableCount}
          </span>
        )}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onSynth}
        disabled={isBusy || isGitProject || !session?.jwt}
        title={
          isGitProject ? "AI voice isn't available on git projects yet" :
          !session?.jwt ? "Sign in to upload audio" :
          missingCount > 0 ? `Translate ${missingCount} cell${missingCount === 1 ? "" : "s"}, then speak ${selectedCells.length} selected` :
          isMulti ? `Speak ${selectedCells.length} selected as one take` :
          "Speak selected cell"
        }
      >
        {running.kind === "synth" || running.kind === "translate-synth" ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : missingCount > 0 ? (
          <Sparkles className="mr-1 h-3.5 w-3.5" />
        ) : (
          <Wand2 className="mr-1 h-3.5 w-3.5" />
        )}
        {synthLabel}
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        onClick={() => clearSelection()}
        disabled={isBusy}
        aria-label="Clear selection"
        title="Clear selection (Esc)"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

/** Preview helper — single shared <audio> so a fresh run cancels the prior. */
let takeAudio: HTMLAudioElement | null = null
let takeUrl: string | null = null

async function playTakePreview(blob: Blob): Promise<void> {
  if (takeAudio) {
    takeAudio.pause()
    takeAudio = null
  }
  if (takeUrl) {
    URL.revokeObjectURL(takeUrl)
    takeUrl = null
  }
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  takeAudio = audio
  takeUrl = url
  audio.onended = () => {
    if (takeAudio === audio) takeAudio = null
    if (takeUrl === url) {
      URL.revokeObjectURL(url)
      takeUrl = null
    }
  }
  try {
    await audio.play()
  } catch (e) {
    console.error("[selection-bar] take playback failed", e)
  }
}
