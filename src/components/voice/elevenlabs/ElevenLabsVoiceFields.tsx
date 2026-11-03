// The ElevenLabs engine's fields in New voice (AQU-2299). Not connected → the
// key row only. Connected → one muted account line, then the voice grid; its
// last card, "Clone a voice", swaps the grid for the clone step. A fresh clone
// comes back to the grid selected, marked "Cloned", ready to Create. "Adjust"
// (model, stability, speed) appears once a voice is picked.
import { useCallback, useEffect, useState } from "react"
import { DEFAULT_ELEVENLABS_MODEL, elevenLabsSettingsOf } from "@/lib/audio/elevenlabs/settings"
import { CUSTOM_VOICE_CONSENT_VERSION } from "@/lib/audio/custom-voice"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import type { Voice } from "@/lib/parsers/types"
import type { ClonedElevenLabsVoice, ElevenLabsVoiceRow } from "@/lib/sync/elevenlabs"
import { ElevenLabsConnect } from "./ElevenLabsConnectCard"
import { ElevenLabsVoiceBrowser } from "./ElevenLabsVoiceBrowser"
import { ElevenLabsClonePanel } from "./ElevenLabsClonePanel"
import { ElevenLabsVoiceTuning } from "./ElevenLabsVoiceTuning"
import { useElevenLabsAccount } from "./useElevenLabsAccount"

export interface ElevenLabsVoiceFieldsProps {
  draft: Voice
  onChange: (patch: Partial<Voice>) => void
  projectId?: string
  fileId?: string | null
  session?: FrontierSession | null
  cells: CellData[]
  /** The lane's language, for Preview's `language_code`. */
  targetLanguage?: string
  /** Editing an existing voice: cloning is a new voice, so only "Use" shows. */
  editing?: boolean
  /** True while the clone step is showing: its own Clone button is the action,
   *  so the dialog hides Create voice until the clone comes back selected. */
  onCloningChange?: (cloning: boolean) => void
}

export function ElevenLabsVoiceFields({
  draft, onChange, projectId, fileId, session, cells, targetLanguage, editing = false, onCloningChange,
}: ElevenLabsVoiceFieldsProps) {
  const connection = useElevenLabsAccount({ projectId, fileId, session })
  const [source, setSource] = useState<"use" | "clone">("use")
  const [reloadToken, setReloadToken] = useState(0)
  useEffect(() => {
    onCloningChange?.(source === "clone" && !editing && Boolean(connection.key))
  }, [source, editing, connection.key, onCloningChange])
  useEffect(() => () => onCloningChange?.(false), [onCloningChange])
  const [pinned, setPinned] = useState<ElevenLabsVoiceRow | null>(null)
  const ref = draft.elevenLabs

  const select = useCallback((voice: ElevenLabsVoiceRow) => {
    onChange({
      elevenLabs: {
        ...(ref ?? {}),
        voiceId: voice.id,
        voiceName: voice.name,
        category: voice.category,
        modelId: ref?.modelId ?? DEFAULT_ELEVENLABS_MODEL,
      },
      // A different account voice is not the clone the consent was given for.
      ...(voice.id !== ref?.voiceId ? { elevenLabsClone: undefined } : {}),
      ...(draft.name.trim() ? {} : { name: voice.name }),
    })
  }, [onChange, ref, draft.name])

  const cloned = useCallback((result: ClonedElevenLabsVoice) => {
    const row: ElevenLabsVoiceRow = {
      id: result.voiceId,
      name: draft.name.trim(),
      category: "cloned",
      labels: {},
      previewUrl: null,
      description: null,
    }
    setPinned(row)
    setReloadToken((n) => n + 1)
    setSource("use")
    onChange({
      elevenLabs: { ...(ref ?? {}), voiceId: row.id, voiceName: row.name, category: "cloned", modelId: ref?.modelId ?? DEFAULT_ELEVENLABS_MODEL },
      elevenLabsClone: {
        consentAttestedAt: result.attestedAt,
        consentAttestedBy: session?.username ?? "",
        consentStatementVersion: result.statementVersion || CUSTOM_VOICE_CONSENT_VERSION,
      },
    })
  }, [draft.name, onChange, ref, session?.username])

  const canClone = connection.state.status === "ready" ? connection.state.account.canClone : undefined
  const cloning = source === "clone" && !editing

  if (!connection.key) {
    return <ElevenLabsConnect connection={connection} projectId={projectId} fileId={fileId} session={session} />
  }

  return (
    <div className="space-y-2.5">
      <ElevenLabsConnect connection={connection} projectId={projectId} fileId={fileId} session={session} />

      {cloning ? (
        <ElevenLabsClonePanel
          name={draft.name}
          projectId={projectId}
          fileId={fileId}
          session={session}
          cells={cells}
          canClone={canClone}
          onCloned={cloned}
          onBack={() => setSource("use")}
        />
      ) : (
        <>
          <ElevenLabsVoiceBrowser
            projectId={projectId}
            fileId={fileId}
            session={session}
            apiKey={connection.key}
            selectedId={ref?.voiceId}
            onSelect={select}
            onClone={editing ? undefined : () => setSource("clone")}
            reloadToken={reloadToken}
            pinned={pinned}
          />
          {ref?.voiceId && (
            <ElevenLabsVoiceTuning
              modelId={ref.modelId}
              settings={elevenLabsSettingsOf(draft)}
              onModelChange={(modelId) => onChange({ elevenLabs: { ...ref, modelId } })}
              onSettingsChange={(settings) => onChange({ elevenLabs: { ...ref, settings } })}
              voiceId={ref.voiceId}
              projectId={projectId}
              fileId={fileId}
              session={session}
              language={draft.language ?? targetLanguage}
            />
          )}
        </>
      )}
    </div>
  )
}
