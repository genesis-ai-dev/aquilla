import { Eye, LayoutGrid, PanelLeft, PenLine, Rows3, Sparkles, SquarePen } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { groupScopes, primaryMount, sentenceCase } from "@/lib/tools/builder-model"
import { cn } from "@/lib/utils"
import type { ToolMount, ToolScope } from "../../../../shared/tools/manifest"
import { useScopeLabel } from "../scope-label"

const MOUNT_ICON = { editor: PenLine, panel: PanelLeft, inline: Rows3, page: LayoutGrid } as const
const MOUNT_TEXT = {
  editor: "extensions.whereLong.editor",
  panel: "extensions.whereLong.panel",
  inline: "extensions.whereLong.inline",
  page: "extensions.whereLong.page",
} as const

/** The one icon that says where an extension lives. */
export function MountIcon({ mounts, className }: { mounts: readonly ToolMount[]; className?: string }) {
  const Icon = MOUNT_ICON[primaryMount(mounts)]
  return (
    <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl border bg-muted/40 text-muted-foreground", className)}>
      <Icon className="size-4" aria-hidden />
    </span>
  )
}

/** "Opens in the editor's side panel, beside the verses." */
export function WhereLine({ mounts }: { mounts: readonly ToolMount[] }) {
  const t = useT()
  const primary = primaryMount(mounts)
  const Icon = MOUNT_ICON[primary]
  return (
    <p className="flex items-start gap-2 text-sm">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span>{t(MOUNT_TEXT[primary])}</span>
    </p>
  )
}

/** What it may do, for people: what it reads (allowed when added), what it
 *  changes (asks first, labelled, undoable), whether it uses AI credits. */
export function ScopeSummary({ scopes }: { scopes: readonly ToolScope[] }) {
  const t = useT()
  const label = useScopeLabel()
  const { reads, changes, ai } = groupScopes(scopes)
  if (scopes.length === 0) return <p className="text-sm text-muted-foreground">{t("extensions.scopes.none")}</p>
  const groups = [
    { key: "reads", icon: Eye, title: t("extensions.scopes.reads"), hint: t("extensions.scopes.readsHint"), scopes: reads },
    { key: "changes", icon: SquarePen, title: t("extensions.scopes.changes"), hint: t("extensions.scopes.changesHint"), scopes: changes },
    { key: "ai", icon: Sparkles, title: t("extensions.scopes.ai"), hint: t("extensions.scopes.aiHint"), scopes: ai },
  ].filter((g) => g.scopes.length > 0)
  return (
    <ul className="flex flex-col gap-3" data-testid="scope-summary">
      {groups.map((g) => (
        <li key={g.key} className="flex items-start gap-2.5" data-scope-group={g.key}>
          <g.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium">{g.title}</p>
            <p className="text-sm text-foreground/80">{sentenceCase(g.scopes.map((s) => label(s)).join(", "))}</p>
            <p className="text-xs text-muted-foreground">{g.hint}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}
