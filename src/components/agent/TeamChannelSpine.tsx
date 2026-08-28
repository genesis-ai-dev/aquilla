/**
 * TeamChannelSpine.tsx — what the main channel collapses to while a thread is
 * open (v2 of the 2026-08-28 social-workspace design).
 *
 * Opening a thread must not cost the user their place in the conversation, so
 * the channel does not disappear: it shrinks to a full-height column of the
 * SAME messages in the SAME order, each reduced to its persona avatar, with
 * the open thread's parent avatar highlighted. Clicking anywhere on the spine
 * returns to the full channel — one target, matching the rail's collapse
 * idiom, so there is nothing to hunt for.
 */

import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type { TeamChannelItem } from "@/lib/agent/team-channel"
import { PersonaAvatar } from "./PersonaAvatar"

export interface TeamChannelSpineProps {
  items: TeamChannelItem[]
  /** Thread whose parent message is highlighted. */
  openThreadId: string
  /** Collapse the thread and restore the full-width channel. */
  onRestore: () => void
}

export function TeamChannelSpine({ items, openThreadId, onRestore }: TeamChannelSpineProps) {
  const t = useT()
  return (
    <button
      type="button"
      onClick={onRestore}
      aria-label={t("agent.team.spineAriaLabel")}
      data-testid="team-channel-spine"
      className="flex w-12 shrink-0 flex-col items-center gap-2 overflow-y-auto border-e py-3 transition-colors hover:bg-accent/40"
    >
      {items.map((item) => {
        const active = item.threadId === openThreadId
        return (
          <span
            key={item.id}
            data-spine-item={item.threadId}
            data-active={active ? "true" : "false"}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-full",
              active && "ring-2 ring-primary ring-offset-1 ring-offset-background",
            )}
          >
            <PersonaAvatar
              personaId={item.persona}
              size="sm"
              className={cn(!active && "opacity-60")}
            />
          </span>
        )
      })}
    </button>
  )
}
