import { useEffect, useRef, useState } from "react"
import type { CellPresencePeer } from "@/lib/sync/presence-store"
import { UserChip } from "@/components/UserChip"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

/** How long a peer reads as "typing…" after their last draft change. */
export const PEER_TYPING_LINGER_MS = 2_000

interface PeerActivity {
  draftText: string | undefined
  typingUntil: number
}

/**
 * Row-level "who is here" indicator: one coloured initials chip per remote
 * peer on this cell, plus a short state label for the first of them.
 *
 * Shown for ANY peer on the row — a viewer reading it, a contributor whose
 * lease claim was denied, or the lease holder — not only when a lock is held.
 * The remote caret/selection overlay still needs a published selection; this
 * badge is the always-on baseline that makes a colleague visible the moment
 * they land on a row.
 */
export function CellPresenceBadges({
  peers,
  now = Date.now,
}: {
  peers: CellPresencePeer[]
  /** Injectable clock for tests. */
  now?: () => number
}) {
  const t = useT()
  const activityRef = useRef(new Map<string, PeerActivity>())
  const [, setTick] = useState(0)

  // Mark a peer as typing whenever their live draft changes; drop the mark
  // after PEER_TYPING_LINGER_MS of silence. The state tick only re-renders
  // this badge, never the row.
  useEffect(() => {
    const at = now()
    const seen = new Set<string>()
    let nextExpiry = Infinity
    for (const peer of peers) {
      seen.add(peer.peerId)
      const draftText = peer.selection?.draftText
      const prev = activityRef.current.get(peer.peerId)
      let typingUntil = prev?.typingUntil ?? 0
      if (prev && draftText !== undefined && draftText !== prev.draftText) {
        typingUntil = at + PEER_TYPING_LINGER_MS
      }
      activityRef.current.set(peer.peerId, { draftText, typingUntil })
      if (typingUntil > at) nextExpiry = Math.min(nextExpiry, typingUntil)
    }
    for (const id of Array.from(activityRef.current.keys())) {
      if (!seen.has(id)) activityRef.current.delete(id)
    }
    setTick((n) => n + 1)
    if (nextExpiry === Infinity) return
    const timer = setTimeout(() => setTick((n) => n + 1), nextExpiry - at + 1)
    return () => clearTimeout(timer)
  }, [peers, now])

  if (peers.length === 0) return null

  const at = now()
  const first = peers[0]
  const firstTyping = (activityRef.current.get(first.peerId)?.typingUntil ?? 0) > at
  const stateLabel = firstTyping
    ? t("editor.presence.typing")
    : first.isEditing
      ? t("editor.presence.editing")
      : t("editor.presence.viewing")

  return (
    <span
      data-cell-presence
      data-cell-presence-state={firstTyping ? "typing" : first.isEditing ? "editing" : "viewing"}
      className="ms-auto inline-flex min-w-0 shrink-0 items-center gap-1 text-[10px] leading-none text-muted-foreground"
      dir="ltr"
    >
      <span className="inline-flex items-center -space-x-1">
        {peers.map((peer) => {
          const typing = (activityRef.current.get(peer.peerId)?.typingUntil ?? 0) > at
          return (
            <span key={peer.peerId} className={cn(typing && "animate-pulse")}>
              <UserChip
                username={peer.username}
                distinguishId={peer.peerId}
                color={peer.color}
                size="xs"
                avatarOnly
                className="[&_svg]:size-4 [&_[data-slot=avatar]]:size-4"
              />
            </span>
          )
        })}
      </span>
      <span className="truncate">
        <UserChip
          username={first.username}
          distinguishId={first.peerId}
          color={first.color}
          hideMark
          className="inline"
          nameClassName="text-[10px] font-medium"
        />
        {peers.length > 1 ? ` +${peers.length - 1}` : ""}
        {" · "}
        {stateLabel}
      </span>
    </span>
  )
}
