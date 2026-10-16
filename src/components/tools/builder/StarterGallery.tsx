import { ArrowUpRight } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { primaryMount } from "@/lib/tools/builder-model"
import { STARTER_EXTENSIONS } from "@/lib/tools/starters"
import { cn } from "@/lib/utils"
import type { ToolManifest } from "../../../../shared/tools/manifest"
import { MOUNT_LABEL, MountIcon } from "./ExtensionFacts"

/** Templates. A click opens the same Try-it review a built one gets. */
export function StarterGallery({ onPick, disabled }: { onPick: (starter: { source: string; manifest: ToolManifest }) => void; disabled: boolean }) {
  const t = useT()
  return (
    <section aria-labelledby="starters-heading" className="flex flex-col gap-3">
      <h2 id="starters-heading" className="text-[13px] font-medium text-muted-foreground">{t("extensions.starters.heading")}</h2>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {STARTER_EXTENSIONS.map((s) => (
          <li key={s.manifest.name}>
            <button
              type="button"
              aria-label={t("extensions.starters.try", { name: s.manifest.name })}
              title={s.manifest.description}
              disabled={disabled}
              onClick={() => onPick({ source: s.source, manifest: s.manifest })}
              className={cn(
                "group flex w-full min-w-0 items-center gap-3 rounded-xl border bg-card p-2.5 pe-3 text-start",
                "transition-[background-color,border-color,transform] duration-150 ease-out hover:border-foreground/15 active:scale-[0.99] motion-reduce:active:scale-100",
                "focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none disabled:opacity-60 dark:bg-transparent dark:hover:bg-input/20",
              )}
            >
              <MountIcon mounts={s.manifest.mounts} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.manifest.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{t(MOUNT_LABEL[primaryMount(s.manifest.mounts)])}</span>
              </span>
              <ArrowUpRight className="size-4 shrink-0 text-muted-foreground/60 transition-[color,transform] duration-150 group-hover:-translate-y-px group-hover:translate-x-px group-hover:text-foreground motion-reduce:transition-none" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
