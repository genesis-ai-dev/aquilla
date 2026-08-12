// Optional onboarding step: pick which AI features the user wants and
// download just those. Defaults to NOTHING selected — nothing is auto-
// downloaded and slow-connection users aren't surprised by a 350 MB pull.
// The user can come back and add features later from project settings.

import { useEffect, useMemo, useState } from "react"
import { CheckCircle2, Download, AlertCircle, ChevronDown, Wifi } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { FieldLabel } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { prefetchAiModels, useModelStatus } from "@/lib/audio/prefetch"
import { storeAllFeaturesConsent } from "@/lib/audio/ai-consent"
import { patchProject, updateProject } from "@/lib/store/project-index"
import type { ProjectRecord, ProjectTtsSettings, TtsProvider } from "@/lib/parsers/types"
import { DEFAULT_MMS_LANGUAGE, DEFAULT_TTS_PROVIDER } from "@/lib/audio/tts-providers"
import { cn } from "@/lib/utils"
import { isValidGeminiKey, describeModelDownload } from "./ai-setup-utils"
import { useT } from "@/lib/i18n/I18nProvider"

type VoiceChoice = "none" | TtsProvider

/** MessageKey, without importing from the generated catalog — see LeftDock.tsx. */
type ModelMessageKey = Parameters<ReturnType<typeof useT>>[0]

interface ModelMeta {
  id: "whisper" | "kokoro" | "mms"
  labelKey: ModelMessageKey
  sizeMb: number
  blurbKey: ModelMessageKey
}

const TRANSCRIBE_MODEL: ModelMeta = {
  id: "whisper",
  labelKey: "onboarding.checklist.aiModels.whisper.label",
  sizeMb: 140,
  blurbKey: "onboarding.checklist.aiModels.whisper.blurb",
}

const KOKORO_MODEL: ModelMeta = {
  id: "kokoro",
  labelKey: "onboarding.checklist.aiModels.kokoro.label",
  sizeMb: 80,
  blurbKey: "onboarding.checklist.aiModels.kokoro.blurb",
}

const MMS_MODEL: ModelMeta = {
  id: "mms",
  labelKey: "onboarding.checklist.aiModels.mms.label",
  sizeMb: 130,
  blurbKey: "onboarding.checklist.aiModels.mms.blurb",
}

interface AiModelsStepProps {
  project: ProjectRecord
  onUpdated: (p: ProjectRecord) => void
}

export function AiModelsStep({ project, onUpdated }: AiModelsStepProps) {
  const t = useT()
  const whisper = useModelStatus("whisper")
  const kokoro = useModelStatus("kokoro")
  const mms = useModelStatus("mms")

  // Selection lives locally — nothing is fetched until the user clicks the
  // explicit Download button. Pre-tick a model that's already downloaded so
  // the UI matches reality on revisit.
  const [wantWhisper, setWantWhisper] = useState(whisper.kind === "ready")
  const [voiceChoice, setVoiceChoice] = useState<VoiceChoice>(() => {
    const provider = project.ttsSettings?.provider
    if (provider === "gemini") return "gemini"
    if (provider === "kokoro" && kokoro.kind === "ready") return "kokoro"
    if (provider === "mms" && mms.kind === "ready") return "mms"
    return "none"
  })
  const [geminiKey, setGeminiKey] = useState(project.ttsSettings?.apiKey ?? "")
  const [geminiError, setGeminiError] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    setGeminiKey(project.ttsSettings?.apiKey ?? "")
  }, [project.ttsSettings?.apiKey])

  // AQU-701: a Gemini key is "confirmed" once a well-formed key is persisted for
  // the gemini provider. When confirmed (and not being replaced) the input
  // collapses to a saved-key summary instead of inviting re-entry.
  const savedGeminiKey = (project.ttsSettings?.apiKey ?? "").trim()
  const hasSavedGeminiKey =
    project.ttsSettings?.provider === "gemini" && isValidGeminiKey(savedGeminiKey)

  const totalSizeMb = useMemo(() => {
    let mb = 0
    if (wantWhisper && whisper.kind !== "ready") mb += TRANSCRIBE_MODEL.sizeMb
    if (voiceChoice === "kokoro" && kokoro.kind !== "ready") mb += KOKORO_MODEL.sizeMb
    if (voiceChoice === "mms" && mms.kind !== "ready") mb += MMS_MODEL.sizeMb
    return mb
  }, [wantWhisper, voiceChoice, whisper.kind, kokoro.kind, mms.kind])

  const anyDownloading =
    whisper.kind === "downloading" ||
    kokoro.kind === "downloading" ||
    mms.kind === "downloading"

  const nothingSelected = !wantWhisper && voiceChoice === "none"
  const allReady =
    (!wantWhisper || whisper.kind === "ready") &&
    (voiceChoice !== "kokoro" || kokoro.kind === "ready") &&
    (voiceChoice !== "mms" || mms.kind === "ready") &&
    (voiceChoice !== "gemini" || isValidGeminiKey(geminiKey))

  async function saveTtsSettings(overrides: Partial<ProjectTtsSettings>) {
    const updated = await patchProject(project.id, (latest) => {
      const base = latest.ttsSettings
      return {
        ...latest,
        ttsSettings: {
          provider: overrides.provider ?? base?.provider ?? DEFAULT_TTS_PROVIDER,
          apiKey: Object.prototype.hasOwnProperty.call(overrides, "apiKey") ? overrides.apiKey : base?.apiKey,
          voices: overrides.voices ?? base?.voices,
          defaultVoiceId: Object.prototype.hasOwnProperty.call(overrides, "defaultVoiceId")
            ? overrides.defaultVoiceId
            : base?.defaultVoiceId,
        },
      }
    })
    if (updated) onUpdated(updated)
  }

  // AQU-701: persist the Gemini key only after a format check, and surface a
  // visible confirmation (collapse) or error — never silently accept input.
  function commitGeminiKey() {
    const k = geminiKey.trim()
    if (!k) {
      setGeminiError(t("onboarding.checklist.aiModels.geminiKeyMissing"))
      return
    }
    if (!isValidGeminiKey(k)) {
      setGeminiError(t("onboarding.checklist.aiModels.geminiKeyInvalid"))
      return
    }
    setGeminiError(null)
    void saveTtsSettings({ provider: "gemini", apiKey: k })
    setEditingKey(false)
  }

  // AQU-701: first-class skip — a team that doesn't use voice/transcription can
  // clear the "not set up" nag; opting back in re-enables the step.
  async function setSkipped(skip: boolean) {
    // Server-loaded projects usually have no IDB row (thin client, AD-3), so a
    // read-then-write patch silently no-ops — seed the row in that case.
    let next = await patchProject(project.id, (p) => ({ ...p, aiSetupSkipped: skip }))
    if (!next) {
      next = { ...project, aiSetupSkipped: skip }
      await updateProject(next)
    }
    onUpdated(next)
  }

  const handleStart = async () => {
    setError(null)
    if (voiceChoice === "gemini" && !isValidGeminiKey(geminiKey)) {
      commitGeminiKey()
      return
    }
    storeAllFeaturesConsent()
    if (voiceChoice !== "none") {
      await saveTtsSettings({
        provider: voiceChoice,
        apiKey: voiceChoice === "gemini" ? (geminiKey.trim() || undefined) : project.ttsSettings?.apiKey,
      })
    }
    const models: Array<"whisper" | "kokoro" | "mms"> = []
    if (wantWhisper && whisper.kind !== "ready") models.push("whisper")
    if (voiceChoice === "kokoro" && kokoro.kind !== "ready") models.push("kokoro")
    if (voiceChoice === "mms" && mms.kind !== "ready") models.push("mms")
    if (models.length === 0) return
    try {
      await prefetchAiModels({
        models,
        mmsLanguage: DEFAULT_MMS_LANGUAGE,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t("onboarding.checklist.aiModels.intro")}
      </p>

      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex w-full items-center justify-between rounded-lg border bg-muted/20 px-3 py-2 text-start text-sm hover:bg-accent/40"
        >
          <span className="flex flex-col">
            <span className="font-medium">{t("onboarding.checklist.aiModels.expandTitle")}</span>
            <span className="text-xs text-muted-foreground">
              {t("onboarding.checklist.aiModels.expandHint")}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>
      ) : (
        <>
          <fieldset className="space-y-1.5 rounded-lg border p-3">
            <legend className="px-1 text-xs font-medium text-muted-foreground">
              {t("onboarding.checklist.aiModels.transcriptionLegend")}
            </legend>
            <ModelCheckRow
              checked={wantWhisper}
              onChange={setWantWhisper}
              meta={TRANSCRIBE_MODEL}
              status={whisper}
            />
          </fieldset>

          <fieldset className="space-y-1.5 rounded-lg border p-3">
            <legend className="px-1 text-xs font-medium text-muted-foreground">
              {t("onboarding.checklist.aiModels.voiceLegend")}
            </legend>
            <RadioGroup
              value={voiceChoice}
              onValueChange={(value) => setVoiceChoice(value as VoiceChoice)}
              className="gap-1.5"
            >
              <RadioRow
                value="none"
                label={t("onboarding.checklist.aiModels.noneLabel")}
                hint={t("onboarding.checklist.aiModels.noneHint")}
              />
              <RadioRow
                value="gemini"
                label={t("onboarding.checklist.aiModels.geminiLabel")}
                hint={t("onboarding.checklist.aiModels.geminiHint")}
              />
              {voiceChoice === "gemini" && (
                hasSavedGeminiKey && !editingKey ? (
                  <div className="ms-6 flex items-center justify-between gap-2 rounded-md bg-muted/30 p-2">
                    <span className="inline-flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {t("onboarding.checklist.aiModels.geminiKeySaved")}
                      <span className="font-mono text-muted-foreground">••••{savedGeminiKey.slice(-4)}</span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => { setGeminiError(null); setEditingKey(true) }}
                    >
                      {t("audio.clone.replaceButton")}
                    </Button>
                  </div>
                ) : (
                  <div className="ms-6 space-y-1 rounded-md bg-muted/30 p-2">
                    <FieldLabel htmlFor="setup-gemini-tts-key" className="text-xs">
                      {t("onboarding.checklist.aiModels.geminiKeyLabel")}
                    </FieldLabel>
                    <div className="flex items-center gap-1.5">
                      <Input
                        id="setup-gemini-tts-key"
                        type="password"
                        value={geminiKey}
                        onChange={(e) => { setGeminiKey(e.target.value); if (geminiError) setGeminiError(null) }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitGeminiKey() } }}
                        onBlur={() => { if (geminiKey.trim()) commitGeminiKey() }}
                        placeholder="AIza..."
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={geminiError ? true : undefined}
                        className="font-mono text-sm"
                      />
                      <Button size="sm" className="h-8 shrink-0" onClick={commitGeminiKey}>
                        {t("onboarding.checklist.aiModels.saveKey")}
                      </Button>
                    </div>
                    {geminiError ? (
                      <p className="text-[10px] text-destructive">{geminiError}</p>
                    ) : (
                      <p className="text-[10px] text-muted-foreground">
                        {t("onboarding.checklist.aiModels.geminiKeyHelp")}
                      </p>
                    )}
                  </div>
                )
              )}
              <ModelRadioRow
                value="kokoro"
                meta={KOKORO_MODEL}
                status={kokoro}
              />
              <ModelRadioRow
                value="mms"
                meta={MMS_MODEL}
                status={mms}
              />
            </RadioGroup>
          </fieldset>

          {totalSizeMb > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/30 dark:text-amber-200">
              <Wifi className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="space-y-0.5">
                <div className="font-medium">{t("onboarding.checklist.aiModels.downloadNotice", { size: totalSizeMb })}</div>
                <p className="text-amber-800/90 dark:text-amber-300/80">
                  {t("onboarding.checklist.aiModels.downloadWarning")}
                </p>
              </div>
            </div>
          )}
        </>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={handleStart}
          disabled={!expanded || nothingSelected || allReady || anyDownloading}
        >
          {nothingSelected
            ? t("onboarding.checklist.aiModels.nothingSelected")
            : allReady
              ? t("autopilot.readiness.level.ready")
              : anyDownloading
                ? t("onboarding.checklist.aiModels.downloadingButton")
                : voiceChoice === "gemini" && !wantWhisper
                  ? t("onboarding.checklist.aiModels.saveKey")
                  : totalSizeMb > 0
                    ? t("onboarding.checklist.aiModels.downloadButtonWithSize", { size: totalSizeMb })
                    : t("onboarding.checklist.aiModels.downloadButton")}
        </Button>
        {anyDownloading && (
          <span className="text-xs text-muted-foreground">
            {t("onboarding.checklist.aiModels.keepWorking")}
          </span>
        )}
        {allReady && !nothingSelected && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">
            {t("onboarding.checklist.aiModels.readyToUse")}
          </span>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {project.aiSetupSkipped ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            {t("onboarding.checklist.aiModels.skippedNotice")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => void setSkipped(false)}
          >
            {t("onboarding.checklist.aiModels.setUpAnyway")}
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void setSkipped(true)}
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
        >
          {t("onboarding.checklist.aiModels.skipLink")}
        </button>
      )}
    </div>
  )
}

// ── rows ───────────────────────────────────────────────────────────────────

interface ModelCheckRowProps {
  checked: boolean
  onChange: (next: boolean) => void
  meta: ModelMeta
  status: ReturnType<typeof useModelStatus>
}

function ModelCheckRow({ checked, onChange, meta, status }: ModelCheckRowProps) {
  const t = useT()
  return (
    <label
      className={cn(
        "flex items-start gap-2 rounded-md px-1 py-1 hover:bg-accent/40",
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        className="mt-1"
      />
      <div className="flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{t(meta.labelKey)}</span>
          <SizeOrStatus meta={meta} status={status} />
        </div>
        <p className="text-xs text-muted-foreground">{t(meta.blurbKey)}</p>
        {status.kind === "downloading" && <DownloadBar status={status} sizeMb={meta.sizeMb} />}
        {status.kind === "error" && (
          <p className="mt-0.5 text-xs text-destructive">{status.message}</p>
        )}
      </div>
    </label>
  )
}

interface RadioRowProps {
  value: VoiceChoice
  label: string
  hint: string
}

function RadioRow({ value, label, hint }: RadioRowProps) {
  return (
    <label className="flex items-start gap-2 rounded-md px-1 py-1 hover:bg-accent/40">
      <RadioGroupItem value={value} className="mt-1" />
      <div className="flex-1">
        <div className="text-sm font-medium">{label}</div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </label>
  )
}

interface ModelRadioRowProps {
  value: VoiceChoice
  meta: ModelMeta
  status: ReturnType<typeof useModelStatus>
}

function ModelRadioRow({ value, meta, status }: ModelRadioRowProps) {
  const t = useT()
  return (
    <label className="flex items-start gap-2 rounded-md px-1 py-1 hover:bg-accent/40">
      <RadioGroupItem value={value} className="mt-1" />
      <div className="flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{t(meta.labelKey)}</span>
          <SizeOrStatus meta={meta} status={status} />
        </div>
        <p className="text-xs text-muted-foreground">{t(meta.blurbKey)}</p>
        {status.kind === "downloading" && <DownloadBar status={status} sizeMb={meta.sizeMb} />}
        {status.kind === "error" && (
          <p className="mt-0.5 text-xs text-destructive">{status.message}</p>
        )}
      </div>
    </label>
  )
}

function SizeOrStatus({
  meta, status,
}: { meta: ModelMeta; status: ReturnType<typeof useModelStatus> }) {
  const t = useT()
  if (status.kind === "ready") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3 w-3" />
        {t("autopilot.readiness.level.ready")}
      </span>
    )
  }
  if (status.kind === "error") {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] text-destructive">
        <AlertCircle className="h-3 w-3" />
        {t("onboarding.checklist.aiModels.statusFailed")}
      </span>
    )
  }
  if (status.kind === "downloading") {
    const { pct } = describeModelDownload(status, meta.sizeMb)
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground tabular-nums">
        <Spinner className="h-3 w-3" />
        {pct !== null ? `${pct}%` : t("onboarding.checklist.aiModels.statusDownloading")}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground">
      <Download className="h-3 w-3" />
      {t("onboarding.checklist.aiModels.sizeMb", { size: meta.sizeMb })}
    </span>
  )
}

function DownloadBar({
  status,
  sizeMb,
}: {
  status: Extract<ReturnType<typeof useModelStatus>, { kind: "downloading" }>
  sizeMb: number
}) {
  const { pct, label } = describeModelDownload(status, sizeMb)
  return (
    <div className="mt-1 space-y-0.5">
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full bg-primary transition-[width] duration-150",
            pct === null && "animate-pulse",
          )}
          style={{ width: `${pct ?? 12}%` }}
        />
      </div>
      <p className="text-[10px] text-muted-foreground tabular-nums">{label}</p>
    </div>
  )
}
