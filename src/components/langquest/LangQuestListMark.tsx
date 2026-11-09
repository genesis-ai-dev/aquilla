// The mark beside a LangQuest-linked project's name in the projects list
// (AQU-2105): the LangQuest logo plus a dot that says whether the link is
// synced, stalled, or broken (the same verdict the saved org connection
// shows in Preferences). Hover or focus names the language and the state.

import { AppTooltip } from "@/components/ui/tooltip"
import { LangQuestLogo } from "@/components/langquest/LangQuestLogo"
import { useT } from "@/lib/i18n/I18nProvider"
import type { PortfolioProject } from "@/lib/frontier/portfolio"
import { cn } from "@/lib/utils"

type State = NonNullable<PortfolioProject["langquest"]>

const DOT: Record<State["health"], string> = {
  synced: "bg-emerald-500",
  stalled: "bg-amber-500",
  broken: "bg-destructive",
}

export function LangQuestListMark({ state }: { state: State }) {
  const t = useT()
  const label = t("langquest.list.ariaLabel", { language: state.language, state: t(`langquest.list.${state.health}`) })
  return (
    <AppTooltip content={label}>
      <span
        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5"
        data-testid="langquest-list-mark"
        data-health={state.health}
        aria-label={label}
        tabIndex={0}
      >
        <LangQuestLogo className="size-3.5" />
        <span className={cn("size-1.5 rounded-full", DOT[state.health])} aria-hidden />
      </span>
    </AppTooltip>
  )
}
