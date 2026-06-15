// VoiceCreator — the simple "make a voice" form. One job: name it, describe how
// it should sound, pick a base Gemini timbre, preview, save. No engine picker, no
// clone layer (that's a separate workflow — see CloneVoiceModal). Editing an
// existing voice reuses this same form and keeps any clone reference untouched.

import { useCallback, useEffect, useRef, useState } from "react"
import { Check, Pause, Play, Star, Trash2 } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import { cn } from "@/lib/utils"
import { newVoiceId, VOICE_PALETTE } from "@/lib/audio/voices"
import { GEMINI_TTS_VOICES, DEFAULT_GEMINI_VOICE } from "@/lib/audio/tts-providers"
import { synthesizeToWavBlob } from "@/lib/audio/tts"
import type { Voice } from "@/lib/parsers/types"

const SAMPLE_TEXT = "The quick brown fox jumps over the lazy dog."

export interface VoiceCreatorProps {
  open: boolean
  onClose: () => void
  /** Voice being edited; null = creating a new one. */
  voice: Voice | null
  apiKey: string
  targetLanguage?: string
  isDefault: boolean
  /** Index used to pick a fresh palette color for a new voice. */
  paletteIndex: number
  onSave: (voice: Voice) => void
  onDelete?: () => void
  onMakeDefault?: () => void
}

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "playing" }
  | { kind: "error"; message: string }

export function VoiceCreator(props: VoiceCreatorProps) {
  if (!props.open) return null
  return <VoiceCreatorBody key={props.voice?.id ?? "new"} {...props} />
}

function VoiceCreatorBody({
  onClose, voice, apiKey, targetLanguage, isDefault, paletteIndex,
  onSave, onDelete, onMakeDefault,
}: VoiceCreatorProps) {
  const isNew = voice === null
  const [draft, setDraft] = useState<Voice>(() =>
    voice ?? {
      id: newVoiceId(),
      name: "New voice",
      color: VOICE_PALETTE[paletteIndex % VOICE_PALETTE.length],
      provider: "gemini",
      voiceName: DEFAULT_GEMINI_VOICE,
    },
  )
  const update = useCallback((patch: Partial<Voice>) => setDraft((d) => ({ ...d, ...patch })), [])

  const [deleteOpen, setDeleteOpen] = useState(false)

  // ── Preview ────────────────────────────────────────────────────────────────
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" })
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const stopPreview = useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null }
    setPreview({ kind: "idle" })
  }, [])
  useEffect(() => stopPreview, [stopPreview])

  const handlePreview = useCallback(async () => {
    if (preview.kind === "playing") { stopPreview(); return }
    if (!apiKey.trim()) {
      setPreview({ kind: "error", message: "Add a Gemini API key in Project Settings to preview." })
      return
    }
    setPreview({ kind: "loading" })
    try {
      const blob = await synthesizeToWavBlob(SAMPLE_TEXT, {
        voice: draft,
        projectProvider: "gemini",
        apiKey,
        geminiContext: { targetLanguage },
      })
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = stopPreview
      setPreview({ kind: "playing" })
      await audio.play()
    } catch (e) {
      setPreview({ kind: "error", message: e instanceof Error ? e.message : String(e) })
    }
  }, [preview.kind, apiKey, draft, targetLanguage, stopPreview])

  const handleSave = useCallback(() => {
    const name = draft.name.trim() || "New voice"
    onSave({ ...draft, name })
    onClose()
  }, [draft, onSave, onClose])

  const baseVoice = draft.voiceName ?? DEFAULT_GEMINI_VOICE

  return (
    <>
      <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
        <DialogContent className="sm:max-w-md">
          <h2 className="font-heading text-base font-medium">{isNew ? "New voice" : "Edit voice"}</h2>

          <div className="space-y-4 pt-1">
            {/* Name + avatar + color */}
            <div className="flex items-center gap-2.5">
              <ColorDot voice={draft} onPick={(c) => update({ color: c })} />
              <Input
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
                className="h-9 min-w-0 flex-1 font-medium"
                placeholder="Voice name"
                aria-label="Voice name"
              />
            </div>

            {/* Describe how it sounds → Gemini voice direction (Voice.prompt). */}
            <div className="space-y-1.5">
              <Label htmlFor="voice-sounds">Sounds like</Label>
              <Textarea
                id="voice-sounds"
                value={draft.prompt ?? ""}
                onChange={(e) => update({ prompt: e.target.value || undefined })}
                rows={2}
                placeholder="e.g. a young man, clear and warm"
              />
            </div>

            {/* Base timbre */}
            <div className="space-y-1.5">
              <Label htmlFor="voice-base">Base voice</Label>
              <Select
                items={GEMINI_TTS_VOICES.map((v) => ({ value: v.name, label: `${v.name} — ${v.description}` }))}
                value={baseVoice}
                onValueChange={(v) => update({ voiceName: v ?? DEFAULT_GEMINI_VOICE })}
              >
                <SelectTrigger id="voice-base" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {GEMINI_TTS_VOICES.map((v) => (
                      <SelectItem key={v.name} value={v.name}>{v.name} — {v.description}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            {/* Preview */}
            <div className="space-y-1.5">
              <Button
                type="button"
                variant="outline"
                onClick={() => void handlePreview()}
                disabled={preview.kind === "loading"}
                className="w-full"
              >
                {preview.kind === "loading" ? <Spinner className="mr-1 h-4 w-4" />
                  : preview.kind === "playing" ? <Pause className="mr-1 h-4 w-4" />
                  : <Play className="mr-1 h-4 w-4" />}
                {preview.kind === "playing" ? "Stop" : "Preview"}
              </Button>
              {preview.kind === "error" && (
                <p className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                  {preview.message}
                </p>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="-mx-5 -mb-5 mt-2 flex flex-wrap items-center gap-2 rounded-b-3xl bg-muted/40 p-5">
            {onMakeDefault && !isDefault && (
              <Button
                type="button" size="sm" variant="outline" onClick={onMakeDefault}
                title="Make this the narrator — used for lines without an explicit speaker."
              >
                <Star className="mr-1 h-3.5 w-3.5" /> Make narrator
              </Button>
            )}
            {isDefault && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Star className="h-3.5 w-3.5 text-primary" /> Narrator
              </span>
            )}
            {onDelete && !draft.builtIn && (
              <Button
                type="button" size="sm" variant="ghost"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button type="button" size="sm" onClick={handleSave}>
                <Check className="mr-1 h-3.5 w-3.5" /> {isNew ? "Create" : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {onDelete && (
        <ConfirmActionDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title="Delete voice"
          description={`Delete "${draft.name}"? This removes the voice for everyone in the project and cannot be undone.`}
          confirmLabel="Delete voice"
          checkboxLabel="I understand this deletes the voice for everyone in the project."
          variant="destructive"
          onConfirm={() => { onDelete(); onClose() }}
        />
      )}
    </>
  )
}

function ColorDot({ voice, onPick }: { voice: Voice; onPick: (c: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Voice color"
        className="rounded-full ring-offset-2 ring-offset-background focus:outline-none focus:ring-2 focus:ring-primary"
      >
        <VoiceAvatar voice={voice} size={36} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 grid grid-cols-6 gap-1 rounded-md border bg-popover p-1.5 shadow-md">
          {VOICE_PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { onPick(c); setOpen(false) }}
              className={cn("h-5 w-5 rounded-full border", c === voice.color && "ring-2 ring-primary")}
              style={{ backgroundColor: c }}
              aria-label={`Pick color ${c}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
