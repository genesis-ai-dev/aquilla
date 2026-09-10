import { useT } from "@/lib/i18n/I18nProvider"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { Headphones, MessageSquare, Play, Pause } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Badge } from "@/components/ui/badge"
import { checkingRequest, type CheckingSession, type CheckingContent, type CheckingRow } from "@/lib/checking/api"
import { checkingLabel, checkingUnitKey } from "@/lib/checking/scope"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import { flushCheckingFeedback, queueCheckingFeedback } from "@/lib/checking/feedback"

export function CheckingPage() {
  const { token = "" } = useParams()
  return <CheckingVisit key={token} token={token} />
}
function CheckingVisit({ token }: { token: string }) {
  const t = useT()
  const storageKey = `aquilla:checking:${token}`
  const [guest, setGuest] = useState<CheckingSession | null>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "null") as CheckingSession | null
      return value && [value.session, value.guestId, value.name, value.title, value.projectId].every(item => typeof item === "string")
        && ["viewer", "commenter", "reviewer"].includes(value.role) ? value : null
    } catch { return null }
  })
  const [name, setName] = useState("")
  const [pin, setPin] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [content, setContent] = useState<CheckingContent | null>(null)
  const [active, setActive] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState("")
  const [sending, setSending] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const playIntent = useRef(false)
  const rows = useMemo(() => {
    const unique = new Map<string, CheckingRow>()
    for (const row of content?.rows ?? []) {
      const key = checkingUnitKey(row)
      if (!unique.has(key) || row.side === "target") unique.set(key, row)
    }
    return [...unique.values()]
  }, [content])
  const canComment = guest?.role !== "viewer"
  const current = rows[active]
  const currentKey = current ? checkingUnitKey(current) : ""
  const feedback = drafts[currentKey] ?? ""
  const setFeedback = (value: string) => setDrafts(previous => ({ ...previous, [currentKey]: value }))
  const attachment = content?.audio.find(audio => current && checkingUnitKey(audio) === checkingUnitKey(current))
  const retry = useCallback(async () => {
    if (!guest) return
    try {
      const count = await flushCheckingFeedback(token, guest)
      if (count) setNotice(t("projectSettings.checking.saved"))
    } catch (error) {
      setNotice(`Feedback stays on this device until it can sync. ${error instanceof Error ? error.message : "Please retry."}`)
    }
  }, [token, guest, t])
  useEffect(() => {
    if (!guest) return
    let current = true
    void checkingRequest<CheckingContent>(`/${token}/content`, guest.session).then(data => {
      if (current) { setContent(data); setError("") }
    }).catch(error => { if (current) setError(String(error.message ?? error)) })
    void retry()
    window.addEventListener("online", retry)
    return () => { current = false; window.removeEventListener("online", retry) }
  }, [guest, token, retry])
  useEffect(() => {
    const element = audioRef.current
    if (!element || !guest || !current || !attachment) { setPlaying(false); return }
    const controller = new AbortController()
    let objectUrl: string | null = null
    element.pause(); element.removeAttribute("src"); element.load(); setPlaying(false)
    const params = new URLSearchParams({ fileId: current.fileId, cellId: current.cellId, audioId: attachment.audioId })
    void fetch(`${syncWorkerHttpOrigin()}/checking/${token}/audio?${params}`, {
      headers: { Authorization: `Bearer ${guest.session}` }, signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(t("projectSettings.checking.recordingUnavailable"))
      const blob = await response.blob()
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      element.src = objectUrl
      element.onloadedmetadata = () => {
        element.currentTime = Math.max(0, Number(attachment.trimStartMs ?? 0) / 1000)
        if (playIntent.current) void element.play().catch(() => { setPlaying(false); setError(t("projectSettings.checking.pressPlay")) })
      }
    }).catch(error => { if (!controller.signal.aborted) { playIntent.current = false; setError(String(error.message ?? error)) } })
    return () => { controller.abort(); element.pause(); element.onloadedmetadata = null; element.removeAttribute("src"); element.load(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [token, guest, current, attachment, t])
  function nextRecording() {
    const next = rows.findIndex((row, index) => index > active && content?.audio.some(audio => checkingUnitKey(audio) === checkingUnitKey(row)))
    if (next < 0) { playIntent.current = false; audioRef.current?.pause(); setPlaying(false); setNotice(t("projectSettings.checking.end")) }
    else setActive(next)
  }
  async function join() {
    setBusy(true); setError("")
    try {
      const result = await checkingRequest<CheckingSession>(`/${token}/join`, undefined, { name: name.trim(), ...(pin ? { pin } : {}) })
      localStorage.setItem(storageKey, JSON.stringify(result)); setGuest(result); setPin("")
    } catch (error) { setError(error instanceof Error ? error.message : t("projectSettings.checking.openFailed")) }
    finally { setBusy(false) }
  }
  async function submitFeedback() {
    if (!guest || !current || !feedback.trim() || sending) return
    setSending(true); setError("")
    try {
      await queueCheckingFeedback(guest, current, feedback)
      setFeedback(""); setNotice(t("projectSettings.checking.syncing"))
      await retry()
    } catch (error) { setError(error instanceof Error ? error.message : t("projectSettings.checking.saveFailed")) }
    finally { setSending(false) }
  }
  return <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-6 px-5 py-8 sm:py-12">
    <header className="flex items-center gap-3"><Headphones className="size-7" /><div><p className="text-sm text-muted-foreground">{t("projectSettings.checking.brand")}</p><h1 className="text-2xl font-semibold">{guest?.title ?? t("projectSettings.checking.welcome")}</h1></div><Badge variant="secondary">WIP</Badge></header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!guest ? <form className="flex flex-col gap-5 rounded-xl border p-6" onSubmit={event => { event.preventDefault(); void join() }}>
      <p>{t("projectSettings.checking.joinHelp")}</p>
      <FieldGroup>
        <Field><FieldLabel htmlFor="checking-name">{t("projectSettings.checking.name")}</FieldLabel><Input id="checking-name" autoComplete="name" value={name} maxLength={80} required onChange={event => setName(event.target.value)} /></Field>
        <Field><FieldLabel htmlFor="guest-pin">{t("projectSettings.checking.guestPin")}</FieldLabel><Input id="guest-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={12} value={pin} onChange={event => setPin(event.target.value)} /></Field>
      </FieldGroup>
      <Button type="submit" disabled={busy || !name.trim()}>{busy ? t("projectSettings.checking.opening") : t("projectSettings.checking.start")}</Button>
    </form> : <>
      <p className="text-sm text-muted-foreground">{guest.name} · {guest.role === "viewer" ? t("projectSettings.checking.listenOnly") : guest.role === "reviewer" ? t("projectSettings.checking.reviewFeedback") : t("projectSettings.checking.listenComment")}</p>
      {!content && !error && <p role="status">{t("projectSettings.checking.loadingPassages")}</p>}
      {content && !rows.length && <p>{t("projectSettings.checking.unavailablePassages")}</p>}
      {current && <>
        <section className="flex flex-col gap-4 rounded-xl border p-5" aria-label={t("projectSettings.checking.player")}>
          <p className="text-sm text-muted-foreground">{current.fileName} · {t("projectSettings.checking.position", { current: active + 1, total: rows.length })}</p>
          <h2 className="text-xl font-medium">{checkingLabel(current.label, active)}</h2>
          <p className="whitespace-pre-wrap text-lg leading-relaxed" dir="auto">{current.text}</p>
          <audio ref={audioRef} controls aria-label={t("projectSettings.checking.recording")} onPlay={() => { setPlaying(true); playIntent.current = true }} onPause={() => setPlaying(false)}
            onError={() => { playIntent.current = false; setPlaying(false); setError(t("projectSettings.checking.playFailed")) }}
            onEnded={nextRecording} onTimeUpdate={() => { const element = audioRef.current; if (element && !element.paused && attachment?.trimEndMs != null && element.currentTime >= Number(attachment.trimEndMs) / 1000) nextRecording() }} />
          <Button disabled={!content?.audio.length} onClick={() => {
            const element = audioRef.current
            if (playing) { playIntent.current = false; element?.pause() }
            else { playIntent.current = true; if (!attachment) { nextRecording(); return }; if (element?.src) void element.play().catch(() => setError(t("projectSettings.checking.playRetry"))) }
          }}>{playing ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}{playing ? t("projectSettings.checking.pause") : t("projectSettings.checking.play")}</Button>
          {!attachment && <p className="text-sm text-muted-foreground">{t("projectSettings.checking.noRecording")}</p>}
          <p className="text-xs text-muted-foreground">{t("projectSettings.checking.playbackHelp")}</p>
        </section>
        {canComment && <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void submitFeedback() }}>
          <Field><FieldLabel htmlFor="checking-feedback"><MessageSquare className="size-4" />{t("projectSettings.checking.feedbackOn", { label: checkingLabel(current.label, active) })}</FieldLabel><Textarea id="checking-feedback" value={feedback} maxLength={10000} required placeholder={t("projectSettings.checking.feedbackPlaceholder")} onChange={event => setFeedback(event.target.value)} /></Field>
          <Button type="submit" disabled={sending || !feedback.trim()}>{t("projectSettings.checking.sendFeedback")}</Button>
        </form>}
        {notice && <div role="status" className="flex flex-col gap-2 text-sm"><p>{notice}</p><Button variant="ghost" onClick={() => void retry()}>{t("projectSettings.checking.retry")}</Button></div>}
        <nav aria-label={t("projectSettings.checking.passages")} className="flex flex-col gap-1">
          {rows.map((row, index) => <Button key={checkingUnitKey(row)} variant={index === active ? "secondary" : "ghost"} className="justify-start" aria-current={index === active ? "true" : undefined}
            onClick={() => { playIntent.current = false; setActive(index); setError("") }}>{row.fileName} · {checkingLabel(row.label, index)}</Button>)}
        </nav>
      </>}
    </>}
  </main>
}
