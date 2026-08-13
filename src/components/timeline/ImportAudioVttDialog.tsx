// Importing an episode's audio VTT — the transcript of what is actually said
// in the film, which becomes the timeline's read-only Source-audio track.
// (AQU-646 stage 2)
//
// Two steps on purpose. The file is picked, parsed IN THE BROWSER, and its
// report shown before anything is uploaded, because the two VTTs an episode
// ships with are easy to confuse: pick the subtitle file by mistake and you
// would otherwise only discover it as a second, wrong-looking track. The cue
// count is the tell — the audio file has ~550 where the subtitle file has ~650.
//
// Every refusal is inline rather than a toast: the dialog is where the mistake
// was made and where the next attempt happens, and a toast fired from behind a
// modal is the message people miss.

import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { parseAudioVtt, type ParsedAudioVtt } from "@/lib/import/audio-vtt"
import { decodeImportText, MAX_UNKNOWN_TEXT_BYTES } from "@/lib/import/ai-recipe"
import { fmtClock } from "./format"

interface Props {
  open: boolean
  /** True when the file already has an audio-cue track: the import replaces it. */
  replacing: boolean
  /** The text file whose timeline gains the track — named so it is obvious
   *  which file the cues are about to be attached to. */
  textFileName: string
  onConfirm(parsed: ParsedAudioVtt, sourceFileName: string): void
  onCancel(): void
}

/** The span the cues cover, read off the first and last cue. */
function cueSpan(parsed: ParsedAudioVtt): string {
  const first = parsed.cues[0]?.start ?? 0
  const last = parsed.cues[parsed.cues.length - 1]?.end ?? 0
  return `${fmtClock(first)} – ${fmtClock(last)}`
}

export function ImportAudioVttDialog({
  open,
  replacing,
  textFileName,
  onConfirm,
  onCancel,
}: Props) {
  const [picked, setPicked] = useState<{ parsed: ParsedAudioVtt; fileName: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setPicked(null)
      setError(null)
    }
  }, [open])

  const handleFile = async (file: File) => {
    setPicked(null)
    setError(null)
    if (file.size === 0) {
      setError("That file is empty.")
      return
    }
    if (file.size > MAX_UNKNOWN_TEXT_BYTES) {
      setError(`"${file.name}" is larger than the 10 MB limit for text imports.`)
      return
    }
    try {
      const parsed = parseAudioVtt(decodeImportText(await file.arrayBuffer(), file.name))
      if (parsed.cues.length === 0) {
        setError("This doesn't look like an audio VTT — no timed cues found.")
        return
      }
      setPicked({ parsed, fileName: file.name })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const report = picked?.parsed.report

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogContent data-testid="import-audio-vtt-dialog">
        <DialogHeader>
          <DialogTitle>
            {replacing ? "Replace the audio VTT" : "Import an audio VTT"}
          </DialogTitle>
          <DialogDescription>
            The cues become a read-only Source audio track on this file's
            timeline — the transcript of what is said in the film, on the film's
            own timings. The dialogue table below is untouched: no rows are
            added to "{textFileName}", and nothing here is translated or
            exported.
            {replacing && " The audio track this file has now will be replaced."}
          </DialogDescription>
        </DialogHeader>

        {picked && report ? (
          <div className="flex flex-col gap-1 text-sm">
            <p className="font-medium">{picked.fileName}</p>
            <p className="text-muted-foreground">
              {report.totalCues} cues, {cueSpan(picked.parsed)}
            </p>
            {report.repairedShortForm > 0 && (
              <p className="text-xs text-muted-foreground">
                {report.repairedShortForm} short-form timestamps read as
                minutes and seconds.
              </p>
            )}
            {report.strippedTagCues > 0 && (
              <p className="text-xs text-muted-foreground">
                Formatting removed from {report.strippedTagCues} cues.
              </p>
            )}
            {report.droppedCues > 0 && (
              <p className="text-xs text-muted-foreground">
                {report.droppedCues} lines carried no usable text and were
                skipped.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted p-6 text-center">
            <label>
              <span className="inline-flex cursor-pointer items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent">
                Choose audio VTT
              </span>
              <input
                type="file"
                accept=".vtt"
                className="sr-only"
                data-testid="import-audio-vtt-input"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  // Clear the input so picking the SAME file again re-fires
                  // change — the usual second attempt after a refusal.
                  e.target.value = ""
                  if (file) void handleFile(file)
                }}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              The episode's audio VTT — usually the one marked AUDIO_ONLY.
            </p>
          </div>
        )}

        {error && (
          <p
            data-testid="import-audio-vtt-error"
            className="text-xs text-red-600 dark:text-red-400"
          >
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            data-testid="import-audio-vtt-cancel"
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            data-testid="import-audio-vtt-confirm"
            disabled={!picked}
            onClick={() => { if (picked) onConfirm(picked.parsed, picked.fileName) }}
          >
            {picked ? `Import ${picked.parsed.cues.length} cues` : "Import cues"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
