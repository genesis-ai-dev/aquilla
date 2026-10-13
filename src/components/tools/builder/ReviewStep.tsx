import { useId, useState } from "react"
import { Plus, RefreshCw, Sparkles, Wand2, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import type { BuildCandidate } from "@/lib/tools/build-jobs"
import { ExtensionPreview } from "./ExtensionPreview"
import { MetaChips, MountIcon } from "./ExtensionFacts"
import { RequirementsList } from "./RequirementsList"

export type ReviewCandidate = BuildCandidate

/** Step 2 — Try it: the preview is the hero. Name and the user's words above,
 *  where/permissions as chips below, one strong "Add to project". */
export function ReviewStep({
  candidate,
  adding,
  changing,
  progress,
  onAdd,
  onChange,
  onDiscard,
}: {
  candidate: ReviewCandidate
  adding: boolean
  /** A change is being rebuilt (Change it…). */
  changing: boolean
  /** The rebuild's live status, shown in place of the actions. */
  progress?: React.ReactNode
  onAdd: () => void
  onChange: (request: string) => void
  onDiscard: () => void
}) {
  const t = useT()
  const id = useId()
  const [changeOpen, setChangeOpen] = useState(false)
  const [change, setChange] = useState("")
  const [quoteOpen, setQuoteOpen] = useState(false)
  const { manifest } = candidate
  const busy = adding || changing
  return (
    <section
      aria-labelledby={`${id}-name`}
      className="flex w-full flex-col gap-4 transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] starting:translate-y-1 starting:opacity-0 motion-reduce:starting:translate-y-0"
      data-testid="built-candidate"
    >
      <header className="flex items-center gap-3">
        <MountIcon mounts={manifest.mounts} className="size-8 rounded-lg" />
        <h2 id={`${id}-name`} className="truncate text-lg font-semibold tracking-[-0.01em]" title={manifest.description}>{manifest.name}</h2>
        <Badge variant="soft" className="shrink-0">
          {candidate.origin === "starter" ? t("extensions.candidate.readyMade") : (
            <><Sparkles className="size-3" aria-hidden />{t("extensions.candidate.builtWithAi")}</>
          )}
        </Badge>
      </header>

      {candidate.request && (
        <button
          type="button"
          onClick={() => setQuoteOpen((v) => !v)}
          aria-expanded={quoteOpen}
          className={cn("-mt-1 border-s-2 ps-3 text-start text-sm text-muted-foreground hover:text-foreground/80", quoteOpen ? "whitespace-pre-wrap" : "truncate")}
          data-testid="candidate-request"
        >
          <span className="font-medium text-foreground/70">{t("extensions.candidate.youAsked")}</span>{" "}“{candidate.request}”
        </button>
      )}

      <ExtensionPreview source={candidate.source} manifest={manifest} />

      <MetaChips mounts={manifest.mounts} scopes={manifest.scopes} />

      {candidate.requirements && <RequirementsList requirements={candidate.requirements} />}

      {progress ?? (changeOpen ? (
        <form
          className="flex items-center gap-2 rounded-2xl border bg-card p-1.5 ps-4 shadow-xs transition-[opacity,transform] duration-200 ease-out starting:translate-y-1 starting:opacity-0"
          onSubmit={(e) => {
            e.preventDefault()
            if (change.trim()) onChange(change.trim())
          }}
        >
          <label htmlFor={`${id}-change`} className="sr-only">{t("extensions.detail.changeTitle")}</label>
          <input
            id={`${id}-change`}
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
            placeholder={t("extensions.change.placeholder")}
            value={change}
            disabled={busy}
            onChange={(e) => setChange(e.target.value)}
          />
          <Button type="button" size="icon-sm" variant="ghost" aria-label={t("common.close")} onClick={() => setChangeOpen(false)}>
            <X className="size-3.5" />
          </Button>
          <Button type="submit" size="sm" className="rounded-full" disabled={busy || !change.trim()}>
            {changing ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" aria-hidden />}
            {t("extensions.candidate.changeSubmit")}
          </Button>
        </form>
      ) : (
        <footer className="flex items-center gap-1.5 border-t pt-4">
          <Button variant="ghost" onClick={onDiscard} disabled={busy} className="text-muted-foreground">{t("extensions.candidate.discard")}</Button>
          {candidate.origin === "builder" && (
            <Button variant="ghost" onClick={() => setChangeOpen(true)} disabled={busy}>
              <Wand2 className="size-3.5" aria-hidden />
              {t("extensions.candidate.change")}
            </Button>
          )}
          <Button
            size="lg"
            className="ms-auto gap-1.5 rounded-full px-4 transition-[transform,background-color] duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100"
            onClick={onAdd}
            disabled={busy}
            data-testid="candidate-add"
          >
            {adding ? <Spinner className="size-4" /> : <Plus className="size-4" aria-hidden />}
            {t("extensions.candidate.add")}
          </Button>
        </footer>
      ))}
    </section>
  )
}
