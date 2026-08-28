/**
 * TeamConversationList.tsx — the middle column of the Team tab's typical
 * three-column chat layout (v2.1, 2026-08-28 notes): a clean list of active
 * conversations, each row a bold name, a one-line preview, a quiet timestamp,
 * and — the ONLY accent on this column — a primary badge for counts that need
 * the human. Flat by design: hairline dividers, no boxes, selection is a
 * tinted row.
 */

import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { fmtShortCalendarDate } from "@/lib/format-date"
import type { TeamConversationRow } from "@/lib/agent/team-conversations"

export type { TeamConversationRow }

export interface TeamConversationListProps {
  rows: TeamConversationRow[]
  selectedId: string
  onSelect: (id: string) => void
}

export function TeamConversationList({ rows, selectedId, onSelect }: TeamConversationListProps) {
  const { locale } = useI18n()
  // Width and chrome belong to the host (the dock panel sizes itself).
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col divide-y divide-border/40" data-testid="team-conversation-list">
          {rows.map((row) => {
            const selected = row.id === selectedId
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => onSelect(row.id)}
                aria-current={selected}
                className={cn(
                  "flex flex-col gap-0.5 px-3 py-2.5 text-start transition-colors hover:bg-accent/50",
                  selected && "bg-accent",
                )}
              >
                <span className="flex items-center gap-1.5">
                  {row.live && <Spinner className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                    {row.title}
                  </span>
                  {row.at && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {fmtShortCalendarDate(row.at, undefined, locale)}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                    {row.preview}
                  </span>
                  {row.badge > 0 && (
                    <Badge className="h-4 min-w-4 shrink-0 px-1 text-[10px]">{row.badge}</Badge>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
