// "Add a voice" (AQU-2577): one panel in the Voices rail for getting a voice
// into the project, in place of choosing a tab first.
//
// One search covers the voices already in the user's ElevenLabs account and
// ElevenLabs' public voice library; a voice is heard and added in one click
// each. Below that, the ways to make a voice that does not exist yet. Those
// open the existing dialog on the matching step — cloning and training carry
// a consent step that stays where it is.
import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowLeft, GraduationCap, Mic, Pause, Play, Sparkles } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { DEFAULT_ELEVENLABS_MODEL, elevenLabsLanguageCode } from "@/lib/audio/elevenlabs/settings"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { newVoiceId, VOICE_PALETTE } from "@/lib/audio/voices"
import {
  addElevenLabsLibraryVoice,
  listElevenLabsVoices,
  searchElevenLabsLibrary,
  type ElevenLabsLibraryVoiceRow,
  type ElevenLabsVoiceRow,
} from "@/lib/sync/elevenlabs"
import { ElevenLabsConnect } from "@/components/voice/elevenlabs/ElevenLabsConnectCard"
import { useElevenLabsAccount } from "@/components/voice/elevenlabs/useElevenLabsAccount"
import type { FrontierSession } from "@/lib/frontier/types"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { Voice } from "@/lib/parsers/types"

/** The steps of the New voice dialog the "make a new one" rows open. */
export type MakeVoiceMode = "tts" | "clone" | "train" | "character"

export interface AddVoicePanelProps {
  projectId: string
  fileId?: string | null
  session: FrontierSession | null
  /** The project's voices, to mark an ElevenLabs voice that is already in it. */
  voices: Voice[]
  /** The lane's language: the library opens filtered to it. */
  language?: string
  /** That language as a person reads it ("Arabic"). */
  languageLabel?: string
  canEdit: boolean
  onBack: () => void
  /** Put a voice in the project's cast. */
  onAdd: (voice: Voice) => Promise<void> | void
  onMakeNew: (mode: MakeVoiceMode) => void
}

interface Row {
  key: string
  name: string
  detail: string
  previewUrl: string | null
  /** The voice's id in the user's account; null for a library voice not saved to it yet. */
  accountVoiceId: string | null
  category?: string
  library?: ElevenLabsLibraryVoiceRow
}

const CATEGORY_KEYS: Record<ElevenLabsVoiceRow["category"], MessageKey> = {
  premade: "audio.elevenLabs.categoryPremade",
  cloned: "audio.elevenLabs.categoryCloned",
  generated: "audio.elevenLabs.categoryDesigned",
  professional: "audio.elevenLabs.categoryProfessional",
}

const detailOf = (labels: Record<string, string>, lead?: string) =>
  [lead, labels.language, labels.accent, labels.gender, labels.age, labels.descriptive ?? labels.use_case]
    .filter((part): part is string => Boolean(part)).join(" · ")

export function AddVoicePanel({
  projectId, fileId, session, voices, language, languageLabel, canEdit, onBack, onAdd, onMakeNew,
}: AddVoicePanelProps) {
  const t = useT()
  const connection = useElevenLabsAccount({ projectId, fileId, session })
  const languageCode = elevenLabsLanguageCode(language)
  const [query, setQuery] = useState("")
  const [onlyLanguage, setOnlyLanguage] = useState(Boolean(languageCode))
  const [account, setAccount] = useState<ElevenLabsVoiceRow[] | null>(null)
  const [library, setLibrary] = useState<ElevenLabsLibraryVoiceRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)

  const key = connection.key
  useEffect(() => {
    if (!key || !session) return
    let live = true
    const getSyncToken = audioSyncTokenFetcherForSession(session)
    const scope = { projectId, fileId, apiKey: key }
    // Wait for the typing to pause: each search is a call on the user's account.
    const timer = setTimeout(() => {
      setError(null)
      void Promise.all([
        listElevenLabsVoices({ ...scope, search: query }, getSyncToken),
        searchElevenLabsLibrary({ ...scope, search: query, ...(onlyLanguage && languageCode ? { language: languageCode } : {}) }, getSyncToken),
      ]).then(([mine, shared]) => {
        if (!live) return
        setAccount(mine.voices)
        setLibrary(shared.voices)
      }).catch((e: unknown) => {
        if (live) setError(categorizeAiError(e instanceof Error ? e.message : String(e)).body)
      })
    }, 300)
    return () => { live = false; clearTimeout(timer) }
  }, [key, session, projectId, fileId, query, onlyLanguage, languageCode])

  // ── One preview at a time ──
  const [playingKey, setPlayingKey] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const stop = useCallback(() => {
    audioRef.current?.pause()
    audioRef.current = null
    setPlayingKey(null)
  }, [])
  useEffect(() => stop, [stop])
  const preview = (row: Row) => {
    const wasPlaying = playingKey
    stop()
    if (wasPlaying === row.key || !row.previewUrl) return
    const audio = new Audio(row.previewUrl)
    audioRef.current = audio
    audio.onended = () => stop()
    setPlayingKey(row.key)
    void audio.play().catch(() => stop())
  }

  const inProject = (elevenLabsVoiceId: string | null) =>
    elevenLabsVoiceId != null && voices.some((v) => v.elevenLabs?.voiceId === elevenLabsVoiceId)

  const add = async (row: Row) => {
    if (!session || !key || adding) return
    setAdding(row.key)
    setError(null)
    try {
      // A library voice is saved to the user's own account first: that is the
      // id their key can speak with.
      const voiceId = row.accountVoiceId ?? await addElevenLabsLibraryVoice(
        { projectId, fileId, apiKey: key, ownerId: row.library!.ownerId, voiceId: row.library!.id, name: row.name },
        audioSyncTokenFetcherForSession(session),
      )
      await onAdd({
        id: newVoiceId(),
        name: row.name,
        color: VOICE_PALETTE[voices.length % VOICE_PALETTE.length],
        provider: "elevenlabs",
        ...(language ? { language } : {}),
        elevenLabs: { voiceId, voiceName: row.name, category: row.category ?? "professional", modelId: DEFAULT_ELEVENLABS_MODEL },
      })
      if (row.library) setLibrary((cur) => cur?.filter((v) => v.id !== row.library!.id) ?? cur)
      setAccount((cur) => (cur && !cur.some((v) => v.id === voiceId)
        ? [...cur, { id: voiceId, name: row.name, category: "professional", labels: row.library?.labels ?? {}, previewUrl: row.previewUrl, description: null }]
        : cur))
    } catch (e) {
      setError(categorizeAiError(e instanceof Error ? e.message : String(e)).body)
    } finally {
      setAdding(null)
    }
  }

  const accountRows: Row[] = (account ?? []).map((v) => ({
    key: `a:${v.id}`, name: v.name, detail: detailOf(v.labels, t(CATEGORY_KEYS[v.category])),
    previewUrl: v.previewUrl, accountVoiceId: v.id, category: v.category,
  }))
  const libraryRows: Row[] = (library ?? []).filter((v) => !v.added).map((v) => ({
    key: `l:${v.id}`, name: v.name, detail: detailOf(v.labels), previewUrl: v.previewUrl, accountVoiceId: null, library: v,
  }))

  const renderRow = (row: Row) => {
    const added = inProject(row.accountVoiceId)
    return (
      <li key={row.key} className="flex items-center gap-2.5 py-1.5">
        <Button
          type="button" variant="outline" size="icon-sm" className="rounded-full" disabled={!row.previewUrl}
          aria-label={playingKey === row.key
            ? t("audio.elevenLabs.pausePreviewAriaLabel", { name: row.name })
            : t("audio.elevenLabs.playPreviewAriaLabel", { name: row.name })}
          onClick={() => preview(row)}
        >
          {playingKey === row.key ? <Pause /> : <Play />}
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{row.name}</p>
          <p className="truncate text-xs text-muted-foreground">{row.detail}</p>
        </div>
        {added ? (
          <span className="shrink-0 text-xs text-muted-foreground">{t("audio.addVoice.inProject")}</span>
        ) : (
          <Button
            type="button" variant="outline" size="sm" disabled={!canEdit || adding != null}
            aria-label={t("audio.addVoice.addAriaLabel", { name: row.name })}
            onClick={() => void add(row)}
          >
            {adding === row.key ? <Spinner className="size-3" /> : null}
            {t("common.add")}
          </Button>
        )}
      </li>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto" data-testid="add-voice-panel" data-showcase="voice.add">
      <div className="space-y-2.5 border-b p-3">
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="icon-sm" aria-label={t("audio.inspector.backToVoices")} onClick={onBack}>
            <ArrowLeft />
          </Button>
          <h2 className="text-sm font-semibold">{t("audio.addVoice.title")}</h2>
        </div>
        <ElevenLabsConnect connection={connection} projectId={projectId} fileId={fileId} session={session} />
        {key && (
          <>
            <Input
              type="search" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder={t("audio.addVoice.searchPlaceholder")} aria-label={t("audio.elevenLabs.searchAriaLabel")}
              className="h-9"
            />
            {languageCode && (
              <button
                type="button" aria-pressed={onlyLanguage}
                className={cn(
                  "h-6 rounded-full border px-2.5 text-xs",
                  onlyLanguage ? "border-primary bg-primary/10 font-medium" : "text-muted-foreground hover:bg-accent",
                )}
                onClick={() => setOnlyLanguage((on) => !on)}
              >
                {t("audio.addVoice.onlyLanguage", { language: languageLabel ?? language ?? languageCode })}
              </button>
            )}
          </>
        )}
        {error && <p className="select-text break-words text-xs text-destructive" role="alert">{error}</p>}
      </div>

      {key && (
        <>
          <section aria-label={t("audio.addVoice.account")} className="border-b px-3 py-2.5">
            <SectionTitle>{t("audio.addVoice.account")}</SectionTitle>
            {account == null
              ? <p role="status" className="py-2 text-xs text-muted-foreground">{t("audio.elevenLabs.loadingVoices")}</p>
              : accountRows.length === 0
                ? <p className="py-2 text-xs text-muted-foreground">{t("audio.elevenLabs.noVoices")}</p>
                : <ul className="divide-y" data-testid="add-voice-account">{accountRows.map(renderRow)}</ul>}
          </section>
          <section aria-label={t("audio.addVoice.library")} className="border-b px-3 py-2.5">
            <SectionTitle>{t("audio.addVoice.library")}</SectionTitle>
            {library == null
              ? <p role="status" className="py-2 text-xs text-muted-foreground">{t("audio.elevenLabs.loadingVoices")}</p>
              : libraryRows.length === 0
                ? <p className="py-2 text-xs text-muted-foreground">{t("audio.elevenLabs.noVoices")}</p>
                : <ul className="divide-y" data-testid="add-voice-library">{libraryRows.map(renderRow)}</ul>}
          </section>
        </>
      )}

      <section aria-label={t("audio.addVoice.makeNew")} className="space-y-2 p-3">
        <SectionTitle>{t("audio.addVoice.makeNew")}</SectionTitle>
        <MakeRow icon={<Mic />} title={t("audio.addVoice.cloneTitle")} body={t("audio.addVoice.cloneBody")} disabled={!canEdit} onClick={() => onMakeNew("clone")} />
        <MakeRow icon={<Sparkles />} title={t("audio.addVoice.designTitle")} body={t("audio.addVoice.designBody")} disabled={!canEdit} onClick={() => onMakeNew("tts")} />
        <MakeRow icon={<GraduationCap />} title={t("audio.addVoice.trainTitle")} body={t("audio.addVoice.trainBody")} disabled={!canEdit} onClick={() => onMakeNew("train")} />
        <p className="text-[11px] text-muted-foreground">{t("audio.addVoice.consentNote")}</p>
      </section>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>
}

function MakeRow({ icon, title, body, disabled, onClick }: {
  icon: React.ReactNode; title: string; body: string; disabled: boolean; onClick: () => void
}) {
  return (
    <button
      type="button" disabled={disabled} onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-start hover:bg-accent disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
    >
      {icon}
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{body}</span>
      </span>
    </button>
  )
}
