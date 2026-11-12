// The hosted model picker (spec §2/§6): Automatic, Whisper, Qwen3-ASR,
// Omnilingual, and the opt-in Omnilingual Zero-Shot. Each named model says
// whether it knows the project's language and lists every language it knows.
//
// Preferences is not inside a project, so the project comes from `?project=`
// (Project Settings → Local AI models links here with it). Without one, the
// rows still list their languages; only the "Supports …" lines and the
// zero-shot example count need a project.

import { useEffect, useMemo, useState } from "react"
import { Check, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { useActiveOrgOptional } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { useProject } from "@/hooks/useProject"
import {
  QWEN3_ASR_DIALECTS, loadOmnilingualCodes, omnilingualLanguages, qwenLanguages,
  toOmniCode, toQwenCode, toWhisperCode, whisperLanguages, type AsrLanguage,
} from "@/lib/audio/asr-catalog"
import { warmZeroShot } from "@/lib/audio/omni-warmup"
import { makeAudioSyncTokenFetcher } from "@/lib/audio/sync-token-fetcher"
import { fetchTranscriptionExamples } from "@/lib/audio/transcription-examples"
import {
  setTranscriptionModel, useTranscriptionModel, type TranscriptionModel,
} from "@/lib/audio/transcription-model"
import { useI18n } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

const ROWS: ReadonlyArray<{ model: TranscriptionModel; label: MessageKey; description: MessageKey }> = [
  { model: "auto", label: "settings.transcription.model.auto", description: "settings.transcription.model.autoDescription" },
  { model: "whisper", label: "settings.transcription.model.whisper", description: "settings.transcription.model.whisperDescription" },
  { model: "qwen3-asr", label: "settings.transcription.model.qwen", description: "settings.transcription.model.qwenDescription" },
  { model: "omni-ctc", label: "settings.transcription.model.omni", description: "settings.transcription.model.omniDescription" },
  { model: "omni-zs", label: "settings.transcription.model.zeroShot", description: "settings.transcription.model.zeroShotDescription" },
]

function projectIdFromUrl(): string {
  try { return new URLSearchParams(window.location.search).get("project") ?? "" }
  catch { return "" }
}

function languageName(tag: string, locale: string): string {
  try { return new Intl.DisplayNames([locale], { type: "language" }).of(tag) ?? tag }
  catch { return tag }
}

export function TranscriptionModelPicker() {
  const { t, locale } = useI18n()
  const { session } = useFrontierSession()
  const org = useActiveOrgOptional()
  const { settings } = useOrgSettings(org?.activeOrgId, org?.activeOrg?.role?.level)
  const zeroShotAllowed = settings.transcription?.zeroShotEnabled !== false
  const stored = useTranscriptionModel(session?.username)
  const model: TranscriptionModel = !zeroShotAllowed && stored === "omni-zs" ? "auto" : stored

  const [projectId] = useState(projectIdFromUrl)
  const { project } = useProject(projectId, { enabled: projectId !== "" })
  const tag = project?.targetLanguage ?? ""

  const [omniCodes, setOmniCodes] = useState<readonly string[] | null>(null)
  useEffect(() => {
    let alive = true
    void loadOmnilingualCodes().then((codes) => { if (alive) setOmniCodes(codes) })
    return () => { alive = false }
  }, [])

  const firstFileId = project?.files[0]?.id
  const [exampleCount, setExampleCount] = useState<number | null>(null)
  useEffect(() => {
    if (!zeroShotAllowed || !session || !projectId || !firstFileId) return
    let alive = true
    fetchTranscriptionExamples({
      projectId, fileId: firstFileId, limit: 10, getSyncToken: makeAudioSyncTokenFetcher(() => session),
    }).then((examples) => { if (alive) setExampleCount(examples.length) }, () => undefined)
    return () => { alive = false }
  }, [zeroShotAllowed, session, projectId, firstFileId])

  const catalogs = useMemo(() => ({
    whisper: whisperLanguages(locale),
    "qwen3-asr": qwenLanguages(locale),
    "omni-ctc": omniCodes ? omnilingualLanguages(omniCodes, locale) : null,
  }), [locale, omniCodes])

  // A project tagged with a language NAME cannot be matched to any catalog.
  const codeShaped = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{1,8})*$/.test(tag)
  const supports = (row: TranscriptionModel): boolean | null => {
    if (!codeShaped) return null
    if (row === "whisper") return toWhisperCode(tag) !== undefined
    if (row === "qwen3-asr") return toQwenCode(tag) !== undefined
    if (row === "omni-ctc") return omniCodes ? toOmniCode(tag, omniCodes) !== undefined : null
    return null
  }

  const choose = (value: TranscriptionModel) => {
    setTranscriptionModel(session?.username, value)
    // Start the slow model now, so the first run does not wait 1–3 minutes.
    if (value === "omni-zs" && session?.jwt) void warmZeroShot(session.jwt, projectId || undefined)
  }

  return (
    <fieldset className="ms-7 space-y-3 border-s ps-4">
      <legend className="mb-2 text-xs font-medium text-muted-foreground">
        {t("settings.transcription.model.legend")}
      </legend>
      {ROWS.filter((row) => row.model !== "omni-zs" || zeroShotAllowed).map((row) => {
        const supported = supports(row.model)
        const catalog = row.model === "whisper" || row.model === "qwen3-asr" || row.model === "omni-ctc"
          ? catalogs[row.model] : null
        return (
          <div key={row.model} className="space-y-1">
            <label className="flex items-start gap-3 text-sm">
              <input
                type="radio"
                name="transcription-model"
                value={row.model}
                checked={model === row.model}
                onChange={() => choose(row.model)}
                className="mt-1 accent-primary"
              />
              <span>
                <span className="font-medium">{t(row.label)}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{t(row.description)}</span>
              </span>
            </label>
            <div className="ms-7 space-y-1 text-xs">
              {supported !== null && (
                <p className={supported ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}>
                  {supported ? <Check className="me-1 inline size-3" /> : <X className="me-1 inline size-3" />}
                  {t(supported ? "settings.transcription.model.supports" : "settings.transcription.model.doesNotSupport",
                    { language: languageName(tag, locale) })}
                </p>
              )}
              {row.model === "omni-zs" && exampleCount !== null && (
                <p className="text-muted-foreground">
                  {t("settings.transcription.model.examples", { count: exampleCount })}
                </p>
              )}
              {catalog && (
                <LanguageList
                  languages={catalog}
                  {...(row.model === "qwen3-asr" ? { dialects: QWEN3_ASR_DIALECTS } : {})}
                />
              )}
            </div>
          </div>
        )
      })}
    </fieldset>
  )
}

function LanguageList({ languages, dialects }: { languages: AsrLanguage[]; dialects?: readonly string[] }) {
  const { t } = useI18n()
  const [query, setQuery] = useState("")
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? languages.filter((l) => l.label.toLowerCase().includes(needle) || l.code.toLowerCase().includes(needle))
    : languages
  return (
    <details className="text-muted-foreground">
      <summary className="cursor-pointer select-none hover:text-foreground">
        {t("settings.transcription.model.seeAll", { count: languages.length })}
      </summary>
      <div className="mt-2 space-y-2">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("settings.transcription.model.search")}
          aria-label={t("settings.transcription.model.search")}
          className="h-8 text-xs"
        />
        <ul className="max-h-48 overflow-y-auto rounded-md border px-3 py-2">
          {shown.map((l) => (
            <li key={l.code} className="flex justify-between gap-3 py-0.5">
              <span>{l.label}</span>
              <span className="font-mono text-[10px] opacity-70">{l.code}</span>
            </li>
          ))}
        </ul>
        {dialects && (
          <p>{t("settings.transcription.model.dialects")}: {dialects.join(", ")}</p>
        )}
      </div>
    </details>
  )
}
