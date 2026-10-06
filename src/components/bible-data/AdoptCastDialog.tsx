// Voices (AQU-1692): "Adopt voices as cast", the confirm step.
//
// A maintainer turns the voices of a chapter, or of the whole file, into the
// lines' cast names (`cast.assign`). The dialog says what will happen before
// anything is written: how many lines get a name, and which lines are left
// out and why, so they can be assigned by hand (see
// src/lib/bible-data/voice-cast.ts for the rules). Names are the speakers'
// labels as this maintainer sees them, and stay as written afterwards.

import { useMemo, useState } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { planVoiceCast, type VoiceCastCell, type VoiceCastLine } from "@/lib/bible-data/voice-cast"
import type { Voice } from "@/lib/bible-data/voice-index"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { BibleVoicesContextValue } from "./voices-context"
import { narratorKey } from "./voice-text"

/** One line's new cast name. */
export interface VoiceCastAssignment {
  cellId: string
  castName: string
}

interface AdoptCastDialogProps {
  /** The chapter the action was chosen in, e.g. "RUT 1". */
  chapter: string
  voices: BibleVoicesContextValue
  cells: () => VoiceCastCell[]
  onAdopt: (assignments: readonly VoiceCastAssignment[]) => void
  onClose: () => void
}

export function AdoptCastDialog({ chapter, voices, cells, onAdopt, onClose }: AdoptCastDialogProps) {
  const t = useT()
  const fmt = useFormat()
  const [scope, setScope] = useState<"chapter" | "file">("chapter")
  // Read once: the cast names as they are when the dialog opens.
  const [snapshot] = useState(cells)
  const { index, labelFor, shared } = voices
  const plan = useMemo(() => {
    const nameOf = (voice: Voice): string | null =>
      voice.kind === "narrator"
        ? t(narratorKey(index.narrator.kind))
        : ((voice.speech.speaker ? labelFor(voice.speech.speaker)?.label : undefined) ?? null)
    return planVoiceCast(index, snapshot, shared, scope === "chapter" ? { kind: "chapter", chapter } : { kind: "file" }, nameOf)
  }, [index, labelFor, snapshot, shared, scope, chapter, t])

  const unknown = t("bibleData.voices.unknownSpeaker")
  const skipped: { key: MessageKey; lines: (VoiceCastLine & { detail?: string })[] }[] = [
    {
      key: "bibleVoices.cast.skippedSeveral",
      lines: plan.several.map((line) => ({ ...line, detail: fmt.list(line.names.map((name) => name ?? unknown)) })),
    },
    { key: "bibleVoices.cast.skippedUnnamed", lines: plan.unnamed },
    { key: "bibleVoices.cast.skippedApproximate", lines: plan.approximate },
    { key: "bibleVoices.cast.keptExisting", lines: plan.kept.map((line) => ({ ...line, detail: line.castName })) },
  ]

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent data-testid="adopt-cast-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("bibleVoices.cast.dialogTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("bibleVoices.cast.dialogDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <RadioGroup
          value={scope}
          onValueChange={(value) => setScope(value === "file" ? "file" : "chapter")}
          aria-label={t("bibleVoices.cast.scope")}
          className="gap-2"
        >
          {(["chapter", "file"] as const).map((value) => (
            <div key={value} className="flex items-center gap-3">
              <RadioGroupItem id={`adopt-cast-${value}`} value={value} />
              <Label htmlFor={`adopt-cast-${value}`} layout="inline" className="font-normal">
                {value === "chapter"
                  ? t("bibleVoices.cast.scopeChapter", { chapter: fmt.isolate(chapter) })
                  : t("bibleVoices.cast.scopeFile")}
              </Label>
            </div>
          ))}
        </RadioGroup>
        <div className="flex max-h-64 flex-col gap-2 overflow-y-auto text-sm">
          <p data-testid="adopt-cast-count" className="font-medium">
            {t("bibleVoices.cast.willAssign", { count: plan.assign.length })}
          </p>
          {skipped.map(({ key, lines }) =>
            lines.length === 0 ? null : (
              <div key={key} data-testid={key}>
                <p className="text-muted-foreground">{t(key, { count: lines.length })}</p>
                <ul className="ms-4 list-disc text-xs text-muted-foreground">
                  {lines.map((line) => (
                    <li key={line.cellId}>
                      <bdi>{line.ref}</bdi>
                      {line.detail && (
                        <>
                          {": "}
                          <bdi>{line.detail}</bdi>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={plan.assign.length === 0}
            onClick={() => {
              onAdopt(plan.assign.map(({ cellId, castName }) => ({ cellId, castName })))
              onClose()
            }}
          >
            {t("bibleVoices.cast.confirm", { count: plan.assign.length })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
