import type { LucideIcon } from "lucide-react"
import { AppWindow, AudioLines, BookOpen, CheckCheck, Eye, MessageSquare, PanelRight, PenLine, Rows3, Sparkles, SquarePen, Type } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import { primaryMount } from "@/lib/tools/builder-model"
import { cn } from "@/lib/utils"
import type { ToolMount, ToolScope } from "../../../../shared/tools/manifest"

export const MOUNT_ICON: Record<ToolMount, LucideIcon> = { editor: PenLine, panel: PanelRight, inline: Rows3, page: AppWindow }
export const MOUNT_LABEL = {
  editor: "extensions.where.choiceEditor",
  panel: "extensions.where.choicePanel",
  inline: "extensions.where.choiceInline",
  page: "extensions.where.choicePage",
} as const

export const PERM = {
  "read:cells": { icon: Eye, label: "extensions.perm.readCells", kind: "read" },
  "read:terms": { icon: BookOpen, label: "extensions.perm.readTerms", kind: "read" },
  "read:comments": { icon: MessageSquare, label: "extensions.perm.readComments", kind: "read" },
  "write:target": { icon: SquarePen, label: "extensions.perm.writeTarget", kind: "write" },
  "write:validation": { icon: CheckCheck, label: "extensions.perm.writeValidation", kind: "write" },
  "write:audio": { icon: AudioLines, label: "extensions.perm.writeAudio", kind: "write" },
  "write:source": { icon: Type, label: "extensions.perm.writeSource", kind: "write" },
  "ai:generate": { icon: Sparkles, label: "extensions.perm.aiGenerate", kind: "ai" },
  "ai:draft": { icon: Sparkles, label: "extensions.perm.aiDraft", kind: "ai" },
} as const satisfies Record<ToolScope, { icon: LucideIcon; label: string; kind: "read" | "write" | "ai" }>
const HINT = { read: "extensions.perm.readHint", write: "extensions.perm.writeHint", ai: "extensions.perm.aiHint" } as const

/** The one icon that says where an extension lives. */
export function MountIcon({ mounts, className }: { mounts: readonly ToolMount[]; className?: string }) {
  const Icon = MOUNT_ICON[primaryMount(mounts)]
  return (
    <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-foreground/70 dark:bg-input/40", className)}>
      <Icon className="size-4" aria-hidden />
    </span>
  )
}

const chip = "inline-flex h-7 items-center gap-1.5 rounded-full border bg-background px-2.5 text-xs text-foreground/80 dark:bg-transparent"

/** Where it appears + what it may do, as icon chips; the rule is in the tooltip. */
export function MetaChips({ mounts, scopes }: { mounts: readonly ToolMount[]; scopes: readonly ToolScope[] }) {
  const t = useT()
  const mount = primaryMount(mounts)
  const Where = MOUNT_ICON[mount]
  const order = { read: 0, write: 1, ai: 2 }
  const perms = [...scopes].sort((a, b) => order[PERM[a].kind] - order[PERM[b].kind])
  return (
    <ul className="flex flex-wrap items-center gap-1.5" data-testid="scope-summary">
      <li className={cn(chip, "font-medium text-foreground")} data-testid="where-chip">
        <Where className="size-3.5" aria-hidden />
        {t(MOUNT_LABEL[mount])}
      </li>
      {perms.length > 0 && <li aria-hidden className="mx-0.5 h-4 w-px bg-border" />}
      {perms.map((s) => {
        const p = PERM[s]
        return (
          <AppTooltip key={s} content={t(HINT[p.kind])}>
            <li className={chip} tabIndex={0} data-scope-kind={p.kind}>
              <p.icon className={cn("size-3.5", p.kind === "write" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")} aria-hidden />
              {t(p.label)}
            </li>
          </AppTooltip>
        )
      })}
      {perms.length === 0 && <li className={cn(chip, "text-muted-foreground")}>{t("extensions.perm.none")}</li>}
    </ul>
  )
}
