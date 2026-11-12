import { useT } from "@/lib/i18n/I18nProvider"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams } from "react-router-dom"
import { Headphones, Pause, Play, SkipBack, SkipForward } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { checkingRequest, type CheckingAudio, type CheckingSession, type CheckingContent, type CheckingRow } from "@/lib/checking/api"
import { checkingLabel, checkingUnitKey } from "@/lib/checking/scope"
import { syncWorkerHttpOrigin } from "@/lib/sync/sync-worker-url"
import { flushCheckingFeedback, queueCheckingFeedback } from "@/lib/checking/feedback"
import { cn } from "@/lib/utils"
import { CheckingDocument } from "./CheckingDocument"

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
  const [pending, setPending] = useState(false)
  const [sending, setSending] = useState(false)
  // Feedback this guest sent, per passage, so it stays visible under the passage
  // like a comment thread. Device-local; the project's copy is the real record.
  const sentKey = `${storageKey}:sent`
  const [sent, setSent] = useState<Record<string, string[]>>(() => {
    try { return JSON.parse(localStorage.getItem(sentKey) ?? "{}") as Record<string, string[]> } catch { return {} }
  })
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
      setPending(false)
      if (count) setNotice(t("projectSettings.checking.saved"))
    } catch (error) {
      setPending(true)
      setNotice(t("projectSettings.checking.pendingFeedback", { reason: error instanceof Error ? error.message : "" }))
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
  // Clips are fetched once and shared, so the next passage's recording can
  // download while this one plays and continuous listening has no fetch gap.
  const clips = useRef(new Map<string, Promise<Blob>>())
  const loadClip = useCallback((audio: CheckingAudio) => {
    let clip = clips.current.get(audio.audioId)
    if (!clip) {
      const params = new URLSearchParams({ fileId: audio.fileId, cellId: audio.cellId, audioId: audio.audioId })
      clip = fetch(`${syncWorkerHttpOrigin()}/checking/${token}/audio?${params}`, {
        headers: { Authorization: `Bearer ${guest?.session ?? ""}` },
      }).then(response => {
        if (!response.ok) throw new Error(t("projectSettings.checking.recordingUnavailable"))
        return response.blob()
      })
      // A failed fetch is retried the next time the passage is opened.
      clip.catch(() => clips.current.delete(audio.audioId))
      clips.current.set(audio.audioId, clip)
    }
    return clip
  }, [token, guest, t])
  const recorded = useMemo(() => {
    const keys = new Set(content?.audio.map(checkingUnitKey))
    return new Set(rows.flatMap((row, index) => keys.has(checkingUnitKey(row)) ? [index] : []))
  }, [rows, content])
  const upcoming = useMemo(() => {
    const index = rows.findIndex((row, position) => position > active && content?.audio.some(audio => checkingUnitKey(audio) === checkingUnitKey(row)))
    return index < 0 ? undefined : content?.audio.find(audio => checkingUnitKey(audio) === checkingUnitKey(rows[index]))
  }, [rows, active, content])
  // Follow along: while listening, keep the passage being heard in view.
  useEffect(() => {
    if (playIntent.current) document.querySelector(`[data-segment="${active}"]`)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" })
  }, [active])
  useEffect(() => {
    const element = audioRef.current
    if (!element || !guest || !current || !attachment) { playIntent.current = false; setPlaying(false); return }
    let cancelled = false
    let objectUrl: string | null = null
    element.pause(); element.removeAttribute("src"); element.load(); setPlaying(false)
    // Keep only this clip and the next one; earlier clips are released.
    for (const audioId of clips.current.keys()) {
      if (audioId !== attachment.audioId && audioId !== upcoming?.audioId) clips.current.delete(audioId)
    }
    void loadClip(attachment).then(blob => {
      if (cancelled) return
      objectUrl = URL.createObjectURL(blob)
      element.src = objectUrl
      element.onloadedmetadata = () => {
        element.currentTime = Math.max(0, Number(attachment.trimStartMs ?? 0) / 1000)
        if (playIntent.current) void element.play().catch(() => { setPlaying(false); setError(t("projectSettings.checking.pressPlay")) })
      }
      if (upcoming) void loadClip(upcoming).catch(() => undefined)
    }).catch(error => { if (!cancelled) { playIntent.current = false; setError(String(error.message ?? error)) } })
    return () => { cancelled = true; element.pause(); element.onloadedmetadata = null; element.removeAttribute("src"); element.load(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [guest, current, attachment, upcoming, loadClip, t])
  /** Opens a passage, like jumping to a chapter of a video: playback carries on
   * from there if it was running. */
  function select(index: number) {
    setActive(Math.max(0, Math.min(rows.length - 1, index))); setError("")
  }
  function playFrom(index: number) {
    playIntent.current = true
    if (index !== active) { select(index); return }
    void audioRef.current?.play().catch(() => setError(t("projectSettings.checking.playRetry")))
  }
  function togglePlay() {
    const element = audioRef.current
    if (playing) { playIntent.current = false; element?.pause(); return }
    playIntent.current = true
    if (!attachment) { nextRecording(); return }
    if (element?.src) void element.play().catch(() => setError(t("projectSettings.checking.playRetry")))
  }
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
      const next = { ...sent, [currentKey]: [...(sent[currentKey] ?? []), feedback.trim()] }
      setSent(next)
      try { localStorage.setItem(sentKey, JSON.stringify(next)) } catch { /* display-only copy */ }
      setFeedback(""); setNotice(t("projectSettings.checking.syncing"))
      await retry()
    } catch (error) { setError(error instanceof Error ? error.message : t("projectSettings.checking.saveFailed")) }
    finally { setSending(false) }
  }
  const label = current ? checkingLabel(current.label, active) : ""
  return <main className="mx-auto flex min-h-dvh max-w-3xl flex-col px-5">
    <header className="flex items-center gap-3 py-6"><Headphones className="size-6 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">{t("projectSettings.checking.brand")}</p><h1 className="truncate text-xl font-semibold">{guest?.title ?? t("projectSettings.checking.welcome")}</h1></div>
      {guest && <p className="text-sm text-muted-foreground">{guest.name} · {guest.role === "viewer" ? t("projectSettings.checking.listenOnly") : guest.role === "reviewer" ? t("projectSettings.checking.reviewFeedback") : t("projectSettings.checking.listenComment")}</p>}</header>
    {error && <p role="alert" className="pb-4 text-sm text-destructive">{error}</p>}
    {!guest ? <form className="flex flex-col gap-5 rounded-xl border p-6" onSubmit={event => { event.preventDefault(); void join() }}>
      <p>{t("projectSettings.checking.joinHelp")}</p>
      <FieldGroup>
        <Field><FieldLabel htmlFor="checking-name">{t("projectSettings.checking.name")}</FieldLabel><Input id="checking-name" autoComplete="name" value={name} maxLength={80} required onChange={event => setName(event.target.value)} /></Field>
        <Field><FieldLabel htmlFor="guest-pin">{t("projectSettings.checking.guestPin")}</FieldLabel><Input id="guest-pin" type="password" inputMode="numeric" autoComplete="off" maxLength={12} value={pin} onChange={event => setPin(event.target.value)} /></Field>
      </FieldGroup>
      <Button type="submit" disabled={busy || !name.trim()}>{busy ? t("projectSettings.checking.opening") : t("projectSettings.checking.start")}</Button>
    </form> : <>
      {!content && !error && <p role="status">{t("projectSettings.checking.loadingPassages")}</p>}
      {content && !rows.length && <p>{t("projectSettings.checking.unavailablePassages")}</p>}
      {current && <>
        <section aria-label={t("projectSettings.checking.player")} className="sticky top-0 z-10 -mx-5 flex flex-col gap-3 border-b bg-background/95 px-5 py-3 backdrop-blur">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" aria-label={t("projectSettings.checking.previous")} disabled={active === 0} onClick={() => select(active - 1)}><SkipBack /></Button>
            <Button size="icon" className="rounded-full" aria-label={playing ? t("projectSettings.checking.pause") : t("projectSettings.checking.play")} disabled={!content?.audio.length} onClick={togglePlay}>{playing ? <Pause /> : <Play />}</Button>
            <Button variant="ghost" size="icon" aria-label={t("projectSettings.checking.next")} disabled={active === rows.length - 1} onClick={() => select(active + 1)}><SkipForward /></Button>
            <div className="min-w-0 flex-1 ps-2">
              <h2 className="truncate font-medium">{label}</h2>
              <p className="truncate text-xs text-muted-foreground">{current.fileName} · {t("projectSettings.checking.position", { current: active + 1, total: rows.length })}{!attachment && ` · ${t("projectSettings.checking.noRecording")}`}</p>
            </div>
          </div>
          {/* Chapter-style strip: one segment per passage, tappable to jump. */}
          <div aria-hidden className={cn("flex h-1.5 overflow-hidden rounded-full", rows.length <= 200 && "gap-px")}>
            {rows.map((row, index) => <div key={checkingUnitKey(row)} onClick={() => select(index)}
              className={cn("flex-1 cursor-pointer", index === active ? "bg-primary" : index < active ? "bg-primary/40" : "bg-muted", !recorded.has(index) && index !== active && "opacity-50")} />)}
          </div>
          <audio ref={audioRef} aria-label={t("projectSettings.checking.recording")} onPlay={() => { setPlaying(true); playIntent.current = true }} onPause={() => setPlaying(false)}
            onError={() => { playIntent.current = false; setPlaying(false); setError(t("projectSettings.checking.playFailed")) }}
            onEnded={nextRecording} onTimeUpdate={() => { const element = audioRef.current; if (element && !element.paused && attachment?.trimEndMs != null && element.currentTime >= Number(attachment.trimEndMs) / 1000) nextRecording() }} />
          {notice && <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><p className="flex-1">{notice}</p>{pending && <Button variant="ghost" size="sm" onClick={() => void retry()}>{t("projectSettings.checking.retry")}</Button>}</div>}
        </section>
        <div className="flex-1 py-6">
          <CheckingDocument rows={rows} active={active} recorded={recorded} onSelect={select} onPlay={playFrom}
            sentCount={index => sent[checkingUnitKey(rows[index])]?.length ?? 0} />
        </div>
        {canComment && <form className="sticky bottom-0 -mx-5 flex flex-col gap-2 border-t bg-background/95 px-5 py-3 backdrop-blur" onSubmit={event => { event.preventDefault(); void submitFeedback() }}>
          {(sent[currentKey] ?? []).length > 0 && <ul aria-label={t("projectSettings.checking.yourFeedback")} className="flex max-h-24 flex-col gap-1 overflow-y-auto text-sm">
            {sent[currentKey].map((body, index) => <li key={index} className="rounded-md bg-muted px-2 py-1"><span className="font-medium">{guest.name}</span> {body}</li>)}
          </ul>}
          <Field><FieldLabel htmlFor="checking-feedback" className="text-xs text-muted-foreground">{t("projectSettings.checking.feedbackOn", { label })}</FieldLabel>
            <div className="flex items-end gap-2">
              <Textarea id="checking-feedback" rows={2} className="min-h-16 flex-1 resize-none" value={feedback} maxLength={10000} required placeholder={t("projectSettings.checking.feedbackPlaceholder")} onChange={event => setFeedback(event.target.value)}
                onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submitFeedback() } }} />
              <Button type="submit" className="shrink-0" disabled={sending || !feedback.trim()}>{t("projectSettings.checking.sendFeedback")}</Button>
            </div>
          </Field>
        </form>}
      </>}
    </>}
  </main>
}
