// TaBiThA translation checks for the tracked verse — a section inside the
// Verse Resources sidebar. Sourced from the gated `/api/v1/aquifer/tabitha`
// proxy (see auth-worker/src/lib/tabitha/client.ts); promise-caching lives in
// `@/lib/tabitha/verse-brief`.

import { useEffect, useState } from "react"
import { ListChecks } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import type { TabithaVerseBrief } from "@/lib/aquifer/client"
import { loadVerseBrief, verseRefFromPassagePath } from "@/lib/tabitha/verse-brief"

/** TaBiThA marks proper-noun spans as `<<Simon's>>`; show them as plain text. */
function plain(text: string): string {
  return text.replace(/<<|>>/g, "")
}

/** A settled load, tagged with the verse it answers so a newer verse reads as loading. */
type Settled = { path: string; brief: TabithaVerseBrief | null }

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  )
}

export function TabithaBriefSection({
  projectId,
  passagePath,
  getJwt,
}: {
  projectId: string
  /** Debounced Aquifer passage path of the tracked verse. */
  passagePath: string
  getJwt: () => string | null
}) {
  const t = useT()
  const [settled, setSettled] = useState<Settled | null>(null)

  useEffect(() => {
    const ref = verseRefFromPassagePath(passagePath)
    const jwt = getJwt()
    if (!ref || !jwt) return
    let cancelled = false
    loadVerseBrief(jwt, projectId, ref)
      .then((brief) => {
        if (!cancelled) setSettled({ path: passagePath, brief })
      })
      .catch(() => {
        if (!cancelled) setSettled({ path: passagePath, brief: null })
      })
    return () => {
      cancelled = true
    }
  }, [passagePath, projectId, getJwt])

  const status = settled?.path !== passagePath ? "loading" : settled.brief ? "ready" : "error"
  const brief = status === "ready" ? (settled?.brief ?? null) : null
  const empty =
    brief &&
    (!brief.available ||
      (brief.notes.length === 0 &&
        brief.translatorNotes.length === 0 &&
        brief.culturalBackground.length === 0))

  return (
    <section className="border-t p-3" aria-label={t("editor.resources.tabitha.title")}>
      <div className="mb-2 flex items-center gap-1.5 font-medium">
        <ListChecks className="h-4 w-4 text-muted-foreground" />
        <span>{t("editor.resources.tabitha.title")}</span>
      </div>

      {status === "loading" ? (
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <Spinner className="mt-0.5 size-3.5 shrink-0" />
          <span>{t("editor.resources.tabitha.loading")}</span>
        </div>
      ) : status === "error" ? (
        <p className="text-xs text-muted-foreground">{t("editor.resources.tabitha.failed")}</p>
      ) : !brief || empty ? (
        <p className="text-xs text-muted-foreground">{t("editor.resources.tabitha.none")}</p>
      ) : (
        <div className="space-y-3 text-xs">
          {brief.lwcText && (
            <div className="space-y-1">
              <Label>{t("editor.resources.tabitha.simpleText")}</Label>
              <p className="leading-relaxed text-muted-foreground">{plain(brief.lwcText)}</p>
            </div>
          )}

          {brief.notes.map((note, i) => (
            <div key={i} className="space-y-1 rounded-md border bg-background p-2">
              {note.topic && <Label>{note.topic}</Label>}
              {note.quotedText && (
                <p className="italic text-muted-foreground">“{plain(note.quotedText)}”</p>
              )}
              {note.meaning && <p className="leading-relaxed">{note.meaning}</p>}
              {note.check && <p className="leading-relaxed text-muted-foreground">{note.check}</p>}
            </div>
          ))}

          {brief.culturalBackground.length > 0 && (
            <div className="space-y-1">
              <Label>{t("editor.resources.tabitha.cultural")}</Label>
              {brief.culturalBackground.map((c, i) => (
                <p key={i} className="leading-relaxed">
                  {c.term && <span className="font-medium">{c.term}: </span>}
                  {c.summary}
                </p>
              ))}
            </div>
          )}

          {brief.translatorNotes.length > 0 && (
            <div className="space-y-1">
              <Label>{t("editor.resources.tabitha.translatorNotes")}</Label>
              {brief.translatorNotes.map((n, i) => (
                <p key={i} className="leading-relaxed">
                  {n}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
