import { ArrowRight } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { STARTER_EXTENSIONS } from "@/lib/tools/starters"
import { cn } from "@/lib/utils"
import type { ToolManifest } from "../../../../shared/tools/manifest"
import { MountIcon } from "./ExtensionFacts"

/** Ready-made extensions. A click opens the same Review & try step a built
 *  one gets (preview + what it may do) — never a silent install. */
export function StarterGallery({ onPick, disabled }: { onPick: (starter: { source: string; manifest: ToolManifest }) => void; disabled: boolean }) {
  const t = useT()
  return (
    <section aria-labelledby="starters-heading" className="flex flex-col gap-2.5">
      <h2 id="starters-heading" className="text-sm font-medium text-muted-foreground">{t("extensions.starters.heading")}</h2>
      <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {STARTER_EXTENSIONS.map((s) => (
          <li key={s.manifest.name}>
            <button
              type="button"
              aria-label={t("extensions.starters.try", { name: s.manifest.name })}
              disabled={disabled}
              onClick={() => onPick({ source: s.source, manifest: s.manifest })}
              className={cn(
                "group flex h-full w-full min-w-0 items-start gap-3 rounded-2xl border bg-card p-3.5 text-start shadow-xs",
                "transition-[background-color,transform] duration-150 hover:bg-muted/50 active:scale-[0.99] motion-reduce:active:scale-100",
                "focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none disabled:opacity-60",
              )}
            >
              <MountIcon mounts={s.manifest.mounts} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{s.manifest.name}</span>
                <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-muted-foreground">{s.manifest.description}</span>
              </span>
              <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
