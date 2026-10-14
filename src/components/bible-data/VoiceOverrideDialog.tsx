// Voices (AQU-1692): a maintainer corrects who speaks a speech, or to whom.
//
// Opened from "Correct…" in the voice details (the chip's popover or the
// cell's Context tab), and mounted once by EditorTable, because the popover
// closes as soon as focus leaves it. The people to choose from are the book's
// participants in the pack's `people` layer, named through the label chain.
// A note is required: a correction is a project decision that someone may
// need to review later. The pack itself is never edited.

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useOnline } from "@/hooks/useOnline"
import type { BkpEntityId, BkpEntityType } from "@/lib/bible-data/pack-types"
import { refOfWord } from "@/lib/bible-data/versification"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { voiceOverrideFailureKey, type SaveVoiceOverride, type VoiceOverrideChange } from "./use-voice-override-writer"
import type { BibleVoicesContextValue } from "./voices-context"

/** Who can speak or be spoken to. Places and unnamed things cannot. */
const PARTICIPANT_TYPES: ReadonlySet<BkpEntityType> = new Set(["person", "group", "deity", "local-person", "local-group"])

interface VoiceOverrideDialogProps {
  speechId: string
  voices: BibleVoicesContextValue
  onSave: SaveVoiceOverride
  onClose: () => void
}

export function VoiceOverrideDialog({ speechId, voices, onSave, onClose }: VoiceOverrideDialogProps) {
  const t = useT()
  const fmt = useFormat()
  const online = useOnline()
  const { index, entities, labelFor } = voices
  const speech = index.speeches.get(speechId)
  const applied = index.overrides.get(speechId)
  const [speaker, setSpeaker] = useState(applied?.override.speaker ?? "")
  const [addressee, setAddressee] = useState(applied?.override.addressee ?? "")
  const [note, setNote] = useState(applied?.override.note ?? "")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<MessageKey | null>(null)

  const people = useMemo(
    () =>
      Object.entries(entities)
        .filter(([, entity]) => PARTICIPANT_TYPES.has(entity.type))
        .map(([id]) => ({ id, name: labelFor(id)?.label ?? id }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [entities, labelFor],
  )
  if (!speech) return null

  const nameOf = (id: BkpEntityId | undefined) => (id ? labelFor(id)?.label : undefined) ?? null
  const original = applied?.original ?? { speaker: speech.speaker, addressee: speech.addressee }
  const ref = refOfWord(index.book, speech.from) ?? index.book
  const canSave = online && !busy && (speaker !== "" || addressee !== "") && note.trim() !== ""

  const run = async (change: VoiceOverrideChange | null) => {
    setBusy(true)
    setError(null)
    const outcome = await onSave(speechId, change)
    setBusy(false)
    if (outcome.kind === "ok") onClose()
    else setError(voiceOverrideFailureKey(outcome))
  }

  const select = (
    id: string,
    labelKey: MessageKey,
    value: string,
    onChange: (next: string) => void,
    packName: string | null,
  ) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{t(labelKey)}</Label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
      >
        <option value="">
          {packName === null
            ? t("bibleVoices.override.keepPackNobody")
            : t("bibleVoices.override.keepPack", { name: fmt.isolate(packName) })}
        </option>
        {people.map((person) => (
          <option key={person.id} value={person.id}>
            {person.name}
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="voice-override-dialog">
        <DialogHeader>
          <DialogTitle>{t("bibleVoices.override.dialogTitle", { ref: fmt.isolate(ref) })}</DialogTitle>
          <DialogDescription>{t("bibleVoices.override.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSave) return
            void run({ ...(speaker ? { speaker } : {}), ...(addressee ? { addressee } : {}), note: note.trim() })
          }}
        >
          {select("voice-override-speaker", "bibleVoices.override.speaker", speaker, setSpeaker, nameOf(original.speaker) ?? t("bibleData.voices.unknownSpeaker"))}
          {select("voice-override-addressee", "bibleVoices.override.addressee", addressee, setAddressee, nameOf(original.addressee))}
          <div className="flex flex-col gap-1">
            <Label htmlFor="voice-override-note">{t("bibleVoices.override.note")}</Label>
            <Textarea
              id="voice-override-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={t("bibleVoices.override.notePlaceholder")}
              dir="auto"
              rows={3}
            />
          </div>
          {!online && <p className="text-xs text-muted-foreground">{t("bibleVoices.override.failed.offline")}</p>}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {t(error)}
            </p>
          )}
          <DialogFooter>
            {applied && (
              <Button type="button" variant="outline" disabled={busy || !online} onClick={() => void run(null)}>
                {t("bibleVoices.override.remove")}
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {t("bibleVoices.override.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
