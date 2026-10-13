import { useId, useState } from "react"
import { Plus, RefreshCw, Sparkles, Wand2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import type { ToolManifest } from "../../../../shared/tools/manifest"
import { ExtensionPreview } from "./ExtensionPreview"
import { MountIcon, ScopeSummary, WhereLine } from "./ExtensionFacts"

export interface ReviewCandidate {
  /** The user's own words (null for a ready-made starter). */
  request: string | null
  source: string
  manifest: ToolManifest
  origin: "builder" | "starter"
}

/** Step 2 — Review & try: what was understood (the user's own words), the
 *  extension running in a sandboxed preview, where it will appear and what it
 *  may do, then Add to project / Change it… / Discard. */
export function ReviewStep({
  candidate,
  adding,
  changing,
  onAdd,
  onChange,
  onDiscard,
}: {
  candidate: ReviewCandidate
  adding: boolean
  /** A change is being rebuilt (Change it…). */
  changing: boolean
  onAdd: () => void
  onChange: (request: string) => void
  onDiscard: () => void
}) {
  const t = useT()
  const id = useId()
  const [changeOpen, setChangeOpen] = useState(false)
  const [change, setChange] = useState("")
  const { manifest } = candidate
  const busy = adding || changing
  return (
    <section
      aria-labelledby={`${id}-name`}
      className="flex flex-col gap-5 rounded-2xl border bg-card p-4 shadow-xs transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0 sm:p-5"
      data-testid="built-candidate"
    >
      <header className="flex items-start gap-3">
        <MountIcon mounts={manifest.mounts} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`${id}-name`} className="text-base font-semibold tracking-tight">{manifest.name}</h2>
            <Badge variant="soft">
              {candidate.origin === "starter" ? t("extensions.candidate.readyMade") : (
                <><Sparkles className="size-3" aria-hidden />{t("extensions.candidate.builtWithAi")}</>
              )}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{manifest.description}</p>
        </div>
      </header>

      {candidate.request && (
        <figure className="rounded-xl border-s-2 border-primary/40 bg-muted/40 px-3.5 py-2.5" data-testid="candidate-request">
          <figcaption className="text-xs font-medium text-muted-foreground">{t("extensions.candidate.youAsked")}</figcaption>
          <blockquote className="mt-0.5 text-sm text-foreground/90">“{candidate.request}”</blockquote>
        </figure>
      )}

      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_15rem]">
        <ExtensionPreview source={candidate.source} manifest={manifest} />
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">{t("extensions.candidate.where")}</h3>
            <WhereLine mounts={manifest.mounts} />
          </div>
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">{t("extensions.candidate.can")}</h3>
            <ScopeSummary scopes={manifest.scopes} />
          </div>
        </div>
      </div>

      {changeOpen && (
        <form
          className="flex flex-col gap-2 rounded-xl border bg-background p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (change.trim()) onChange(change.trim())
          }}
        >
          <label htmlFor={`${id}-change`} className="text-sm font-medium">{t("extensions.candidate.changeLabel")}</label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id={`${id}-change`}
              className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20"
              placeholder={t("extensions.change.placeholder")}
              value={change}
              disabled={busy}
              onChange={(e) => setChange(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={busy || !change.trim()}>
              {changing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" aria-hidden />}
              {t("extensions.candidate.changeSubmit")}
            </Button>
          </div>
        </form>
      )}

      <footer className="flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center">
        <Button variant="ghost" onClick={onDiscard} disabled={busy}>{t("extensions.candidate.discard")}</Button>
        {!changeOpen && candidate.origin === "builder" && (
          <Button variant="outline" onClick={() => setChangeOpen(true)} disabled={busy}>
            <Wand2 className="size-3.5" aria-hidden />
            {t("extensions.candidate.change")}
          </Button>
        )}
        <Button size="lg" className="gap-1.5 px-4 sm:ms-auto" onClick={onAdd} disabled={busy} data-testid="candidate-add">
          {adding ? <Spinner className="size-4" /> : <Plus className="size-4" aria-hidden />}
          {t("extensions.candidate.add")}
        </Button>
      </footer>
    </section>
  )
}
