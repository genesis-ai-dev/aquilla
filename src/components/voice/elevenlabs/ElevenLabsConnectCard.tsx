// Connect ElevenLabs (AQU-2299, bring-your-own-key).
//
// No key on this device → a compact card: paste the key (show/hide), Connect,
// "Get a key". Connect validates the key against the account route before
// saving it, so a typo never gets stored. With a key → a slim bar: plan tier,
// characters left as a meter, Disconnect.
//
// The key lives on this device for this user only (src/lib/audio/elevenlabs/key.ts)
// and the card says so; it never enters project settings.
import { useState, type FormEvent } from "react"
import { ExternalLink, KeyRound, Lock } from "lucide-react"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RevealableInput } from "@/components/ui/revealable-input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
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

/** The card, reading the account itself. For surfaces that need nothing else. */
export function ElevenLabsConnectCard(props: ElevenLabsAccountScope & { className?: string }) {
  const connection = useElevenLabsAccount(props)
  return <ElevenLabsConnect {...props} connection={connection} />
}

/** The card for a caller that already holds `useElevenLabsAccount`'s result. */
export function ElevenLabsConnect({
  connection,
  className,
  ...scope
}: ElevenLabsAccountScope & {
  connection: ReturnType<typeof useElevenLabsAccount>
  className?: string
}) {
  return connection.key
    ? <ConnectedBar state={connection.state} onRetry={connection.refresh} className={className} />
    : <ConnectForm {...scope} className={className} />
}

function ConnectForm({ projectId, fileId, session, className }: ElevenLabsAccountScope & { className?: string }) {
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
      className={cn("space-y-3 rounded-xl border bg-card p-3.5", className)}
      aria-label={t("audio.elevenLabs.connectTitle")}
    >
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
          <KeyRound className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium leading-5">{t("audio.elevenLabs.connectTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("audio.elevenLabs.connectBody")}</p>
        </div>
      </div>
      <div className="flex gap-2">
        <RevealableInput
          revealKind="key"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(null) }}
          placeholder={t("audio.elevenLabs.keyPlaceholder")}
          aria-label={t("audio.elevenLabs.keyAriaLabel")}
          autoComplete="off"
          spellCheck={false}
          className="h-9 min-w-0 flex-1 font-mono"
        />
        <Button type="submit" disabled={!draft.trim() || busy || !canValidate}>
          {busy ? <Spinner className="size-3" /> : null}
          {t("audio.elevenLabs.connectButton")}
        </Button>
      </div>
      {error && <p className="select-text break-words text-xs text-destructive" role="alert">{error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Lock className="size-3" aria-hidden />
          {t("audio.elevenLabs.keyStaysOnDevice")}
        </span>
        <a
          href={ELEVENLABS_KEYS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
        >
          {t("audio.elevenLabs.getKey")}
          <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>
    </form>
  )
}

function ConnectedBar({
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
  const disconnect = (
    <Button type="button" variant="ghost" size="sm" className="shrink-0 text-muted-foreground" onClick={() => setElevenLabsKey(undefined)}>
      {t("audio.elevenLabs.disconnect")}
    </Button>
  )
  const shell = cn("flex items-center gap-3 rounded-xl border bg-card px-3 py-2", className)

  if (state.status === "error") {
    return (
      <div className={cn(shell, "border-destructive/40")} role="status">
        <span className="size-2 shrink-0 rounded-full bg-destructive" aria-hidden />
        <p className="min-w-0 flex-1 text-xs text-destructive">
          {state.message ? categorizeAiError(state.message).body : t("audio.elevenLabs.accountUnavailable")}
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={onRetry}>{t("common.retry")}</Button>
        {disconnect}
      </div>
    )
  }
  if (state.status !== "ready") {
    return (
      <div className={shell} role="status" aria-label={t("audio.elevenLabs.checkingAccount")}>
        <span className="size-2 shrink-0 animate-pulse rounded-full bg-muted-foreground/40 motion-reduce:animate-none" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1.5">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-1 w-full" />
        </div>
        {disconnect}
      </div>
    )
  }

  const { account } = state
  const left = Math.max(0, account.characterLimit - account.characterCount)
  const pct = account.characterLimit > 0 ? Math.min(100, (left / account.characterLimit) * 100) : 0
  const low = pct < 10
  const nf = new Intl.NumberFormat(locale)
  const tier = account.tier ? account.tier.charAt(0).toUpperCase() + account.tier.slice(1) : ""
  return (
    <div className={shell} data-testid="elevenlabs-connected">
      <AppTooltip content={t("audio.elevenLabs.connectedTooltip")}>
        <span className="size-2 shrink-0 rounded-full bg-emerald-500" aria-label={t("audio.elevenLabs.connectedAriaLabel")} role="img" />
      </AppTooltip>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5 text-xs">
          {/* i18n-exempt: brand name */}
          <span className="font-medium">ElevenLabs</span>
          {tier && <Badge variant="soft" className="h-4 px-1.5 text-[10px]">{tier}</Badge>}
          <span className={cn("ms-auto truncate tabular-nums", low ? "text-destructive" : "text-muted-foreground")}>
            {t("audio.elevenLabs.charactersLeft", { left: nf.format(left), limit: nf.format(account.characterLimit) })}
          </span>
        </div>
        <div
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={account.characterLimit}
          aria-valuenow={left}
          aria-label={t("audio.elevenLabs.quotaMeterAriaLabel")}
        >
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", low ? "bg-destructive" : "bg-primary")}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      {disconnect}
    </div>
  )
}
