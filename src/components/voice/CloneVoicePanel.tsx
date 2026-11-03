// The Clone voice tab of NewVoiceModal: an Inworld instant ("quick") clone
// from one short clip of a real person. The clip is recorded or uploaded
// (VoiceCloneSection), or copied from one of this project's recorded lines; it
// is stored project-scoped in R2 and the voice points at it with
// `referenceAudioId`. The sync-worker's /tts clones it through Inworld the
// first time the voice reads a line (cached), so there is no engine to pick —
// a quick clone is always Inworld. It reads text; it cannot re-voice a take
// (Change voice needs a character, trained or ElevenLabs voice).
//
// A quick clone is still a real person's voice, so it carries the same
// organization consent confirmation as Train voice and ElevenLabs cloning
// (VoiceConsentBox); the modal will not save one until it is ticked.

import { useCallback, useMemo, useState, type ReactNode } from "react"
import { Check } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { VoiceCloneSection } from "@/components/VoiceCloneSection"
import { VoiceConsentBox } from "@/components/voice/VoiceConsentBox"
import { InworldDesignLocaleFields } from "@/components/voice/InworldDesignLocaleFields"
import { lineSnippet, linesWithTakes } from "@/components/voice/elevenlabs/helpers"
import { cn } from "@/lib/utils"
import { fetchTakeAsFile } from "@/lib/audio/take-file"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { buildVoiceReferenceId, uploadVoiceReference } from "@/lib/audio/voice-clone"
import type { Voice } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"

export interface CloneVoicePanelProps {
  draft: Voice
  onChange: (patch: Partial<Voice>) => void
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  cells: CellData[]
  /** The language the clone is made and read in (Inworld locale). */
  language?: string
  onLanguageChange: (language: string) => void
  consent: boolean
  onConsentChange: (consent: boolean) => void
  /** Reports a failed take copy (the modal shows it in its footer). */
  onError: (message: string | null) => void
  /** The Inworld quality / delivery / speed knobs, shown above the consent box. */
  children?: ReactNode
}

/** `${cellId}:${audioId}` — how a clone remembers the take its clip came from. */
const cloneTakeKey = (cellId: string, audioId: string) => `${cellId}:${audioId}`

export function CloneVoicePanel({
  draft, onChange, projectId, fileId, session, cells, language, onLanguageChange,
  consent, onConsentChange, onError, children,
}: CloneVoicePanelProps) {
  const t = useT()
  const takes = useMemo(() => linesWithTakes(cells), [cells])
  const [copying, setCopying] = useState<string | null>(null)

  const pickTake = useCallback(async (cell: CellData, audioId: string) => {
    if (!projectId || copying) return
    setCopying(audioId)
    onError(null)
    try {
      const file = await fetchTakeAsFile({ projectId, cell, audioId, session: session ?? null })
      const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1) : "wav"
      const referenceAudioId = buildVoiceReferenceId(ext)
      await uploadVoiceReference({
        projectId,
        fileId: cell.fileId,
        referenceAudioId,
        blob: file,
        getSyncToken: audioSyncTokenFetcherForSession(session ?? null),
      })
      onChange({ referenceAudioId, referenceTakeKey: cloneTakeKey(cell.id, audioId) })
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setCopying(null)
    }
  }, [projectId, session, copying, onChange, onError])

  return (
    <div className="space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">{t("audio.newVoice.cloneIntro")}</p>

      <Field>
        <FieldLabel htmlFor="clone-voice-name">{t("common.name")}</FieldLabel>
        <Input
          id="clone-voice-name"
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="h-10"
          placeholder={t("audio.newVoice.namePlaceholder")}
          aria-label={t("audio.newVoice.nameAriaLabel")}
          autoFocus
        />
      </Field>

      <InworldDesignLocaleFields
        copy="catalog"
        language={language}
        onLanguageChange={onLanguageChange}
        projectId={projectId}
        fileId={fileId}
        session={session}
      />

      <div className="space-y-2">
        <VoiceCloneSection
          voice={draft}
          projectId={projectId}
          fileId={fileId}
          session={session}
          onChange={onChange}
        />
        {takes.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-center text-[11px] text-muted-foreground">{t("audio.elevenLabs.cloneFromLines")}</p>
            <ul
              className="flex max-h-24 flex-wrap justify-center gap-1 overflow-y-auto"
              aria-label={t("audio.elevenLabs.cloneFromLinesAriaLabel")}
            >
              {takes.map(({ cell, audioId }) => {
                const chosen = draft.referenceTakeKey === cloneTakeKey(cell.id, audioId)
                return (
                  <li key={`${cell.id}-${audioId}`}>
                    <button
                      type="button"
                      disabled={copying !== null || !projectId}
                      title={cell.cellLabel || undefined}
                      aria-pressed={chosen}
                      onClick={() => void pickTake(cell, audioId)}
                      className={cn(
                        "inline-flex h-6 max-w-[14rem] items-center gap-1 rounded-full border px-2.5 text-[11px] text-muted-foreground transition-colors",
                        "hover:border-foreground/20 hover:text-foreground disabled:pointer-events-none",
                        chosen && "border-primary bg-primary/15 text-primary",
                      )}
                    >
                      {copying === audioId ? <Spinner className="size-3" /> : chosen ? <Check className="size-3" aria-hidden /> : null}
                      <span className="truncate">{lineSnippet(cell)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>

      {children}

      <VoiceConsentBox id="inworld-clone-consent" checked={consent} onCheckedChange={onConsentChange} />
    </div>
  )
}
