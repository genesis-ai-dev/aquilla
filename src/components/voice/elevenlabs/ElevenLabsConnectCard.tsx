// Connect ElevenLabs (AQU-2299, bring-your-own-key).
//
// No key on this device → one row: the key input and Connect, with a single
// muted line under it ("Stays on this device · Get a key"). Connect validates
// the key against the account route before saving it, so a typo never gets
// stored. With a key → one muted line: "ElevenLabs · N characters left" and a
// quiet Disconnect.
//
// The key lives on this device for this user only (src/lib/audio/elevenlabs/key.ts);
// it never enters project settings.
import { useState, type FormEvent, type ReactNode } from "react"
import { ExternalLink } from "lucide-react"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { setElevenLabsKey } from "@/lib/audio/elevenlabs/key"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { fetchElevenLabsAccount } from "@/lib/sync/elevenlabs"
import {
  useElevenLabsAccount,
  type ElevenLabsAccountScope,
  type ElevenLabsAccountState,
} from "./useElevenLabsAccount"

export const ELEVENLABS_KEYS_URL = "https://elevenlabs.io/app/settings/api-keys"

/** Reads the account itself. For surfaces that need nothing else (Project settings). */
export function ElevenLabsConnectCard(props: ElevenLabsAccountScope & { className?: string }) {
  const connection = useElevenLabsAccount(props)
  return <ElevenLabsConnect {...props} connection={connection} />
}

/** For a caller that already holds `useElevenLabsAccount`'s result. */
export function ElevenLabsConnect({
  connection,
  className,
  ...scope
}: ElevenLabsAccountScope & {
  connection: ReturnType<typeof useElevenLabsAccount>
  className?: string
}) {
  return connection.key
    ? <ConnectedLine state={connection.state} onRetry={connection.refresh} className={className} />
    : <ConnectRow {...scope} className={className} />
}

function ConnectRow({ projectId, fileId, session, className }: ElevenLabsAccountScope & { className?: string }) {
  const t = useT()
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canValidate = Boolean(projectId && session)

  const connect = async (e: FormEvent) => {
    e.preventDefault()
    const key = draft.trim()
    if (!key || !projectId || !session || busy) return
    setBusy(true)
    setError(null)
    try {
      await fetchElevenLabsAccount({ projectId, fileId, apiKey: key }, audioSyncTokenFetcherForSession(session))
      setElevenLabsKey(key)
    } catch (err) {
      setError(categorizeAiError(err instanceof Error ? err.message : String(err)).body)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={(e) => void connect(e)}
      className={cn("space-y-1.5", className)}
      aria-label={t("audio.elevenLabs.connectTitle")}
    >
      <div className="flex gap-2">
        <Input
          type="password"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(null) }}
          placeholder={t("audio.elevenLabs.keyPlaceholder")}
          aria-label={t("audio.elevenLabs.keyAriaLabel")}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 font-mono"
        />
        <Button type="submit" className="h-9" disabled={!draft.trim() || busy || !canValidate}>
          {busy ? <Spinner className="size-3" /> : null}
          {t("audio.elevenLabs.connectButton")}
        </Button>
      </div>
      {error && <p className="select-text break-words text-xs text-destructive" role="alert">{error}</p>}
      <p className="text-[11px] text-muted-foreground">
        {t("audio.elevenLabs.keyStaysOnDevice")}
        {" · "}
        <a
          href={ELEVENLABS_KEYS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 underline-offset-2 hover:text-foreground hover:underline"
        >
          {t("audio.elevenLabs.getKey")}
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </p>
    </form>
  )
}

function ConnectedLine({
  state,
  onRetry,
  className,
}: {
  state: ElevenLabsAccountState
  onRetry: () => void
  className?: string
}) {
  const t = useT()
  const { locale } = useI18n()

  let body: ReactNode
  let title: string | undefined
  if (state.status === "ready") {
    const { account } = state
    const left = Math.max(0, account.characterLimit - account.characterCount)
    const low = account.characterLimit > 0 && left / account.characterLimit < 0.1
    title = account.tier ? account.tier.charAt(0).toUpperCase() + account.tier.slice(1) : undefined
    body = (
      <span className={cn("tabular-nums", low && "text-destructive")}>
        {t("audio.elevenLabs.charactersLeft", { left: new Intl.NumberFormat(locale).format(left) })}
      </span>
    )
  } else if (state.status === "error") {
    body = (
      <span className="text-destructive" role="alert">
        {state.message ? categorizeAiError(state.message).body : t("audio.elevenLabs.accountUnavailable")}
      </span>
    )
  } else {
    body = <span role="status">{t("audio.elevenLabs.checkingAccount")}</span>
  }

  return (
    <div className={cn("flex items-center gap-1 text-xs text-muted-foreground", className)} data-testid="elevenlabs-connected">
      <p className="min-w-0 flex-1 truncate" title={title}>
        {/* i18n-exempt: brand name */}
        <span className="font-medium text-foreground">ElevenLabs</span>
        {" · "}
        {body}
      </p>
      {state.status === "error" && (
        <Button type="button" variant="ghost" size="xs" onClick={onRetry}>{t("common.retry")}</Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="shrink-0 text-muted-foreground"
        onClick={() => setElevenLabsKey(undefined)}
      >
        {t("audio.elevenLabs.disconnect")}
      </Button>
    </div>
  )
}
