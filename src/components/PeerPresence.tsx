import { useState } from "react"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  presentCellOf,
  usePresencePeers,
  type ProjectPresencePeer,
  type ProjectPresenceStore,
} from "@/lib/sync/presence-store"
import { useT } from "@/lib/i18n/I18nProvider"

interface PeerPresenceProps {
  /** Pre-resolved roster. Prefer `store` so only this component re-renders on roster changes. */
  peers?: ProjectPresencePeer[]
  /** Subscribes to the roster here, keeping the workspace root out of the render loop. */
  store?: ProjectPresenceStore | null
  onJumpToPeer?: (peer: ProjectPresencePeer) => void
  /** Human label (verse ref) for a cell id in the open file, if known. */
  resolveCellLabel?: (cellId: string) => string | undefined
}

export function PeerPresence({ peers: peersProp, store, onJumpToPeer, resolveCellLabel }: PeerPresenceProps) {
  const t = useT()
  const [showPopover, setShowPopover] = useState(false)
  const storePeers = usePresencePeers(store ?? null)
  const peers = peersProp ?? storePeers

  if (peers.length === 0) return null

  const visible = peers.slice(0, 5)
  const overflow = peers.length - 5
  const firstPeer = peers[0]
  const firstPeerCell = firstPeer ? presentCellOf(firstPeer) : undefined
  const firstPeerAt = firstPeerCell ? resolveCellLabel?.(firstPeerCell) : undefined
  const label = peers.length === 1 && firstPeer
    ? firstPeerAt ? `${firstPeer.username} · ${firstPeerAt}` : firstPeer.username
    : t("workspace.peerPresence.onlineCount", { count: peers.length })

  return (
    <Popover open={showPopover} onOpenChange={setShowPopover}>
      <AppTooltip content={t("workspace.peerPresence.collaboratorsOnlineTooltip", { count: peers.length })}>
        <PopoverTrigger
          render={
            <button
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-background/80 px-1.5 pe-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              <AvatarGroup className="-space-x-1 *:data-[slot=avatar]:ring-background">
                {visible.map((peer) => (
                  <InitialsAvatar
                    key={peer.peerId}
                    name={peer.username}
                    size="xs"
                    color={peer.color}
                  />
                ))}
                {overflow > 0 && (
                  <AvatarGroupCount className="size-5 text-[9px] font-semibold">
                    +{overflow}
                  </AvatarGroupCount>
                )}
              </AvatarGroup>
              <span className="hidden max-w-40 truncate leading-none sm:inline">{label}</span>
            </button>
          }
        />
      </AppTooltip>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-56 gap-0 p-2"
        aria-label={t("workspace.peerPresence.onlineCount", { count: peers.length })}
      >
        <ul className="flex flex-col gap-1">
          {peers.map((peer) => {
            const cellId = presentCellOf(peer)
            const canJump = Boolean(peer.currentFileId || cellId)
            const at = cellId ? resolveCellLabel?.(cellId) : undefined
            return (
              <li key={peer.peerId}>
                <button
                  type="button"
                  disabled={!canJump}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-start text-xs transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
                  onClick={() => {
                    if (!canJump) return
                    onJumpToPeer?.(peer)
                    setShowPopover(false)
                  }}
                >
                  <InitialsAvatar name={peer.username} size="xs" color={peer.color} />
                  <span className="truncate">{peer.username}</span>
                  <span className="ms-auto shrink-0 text-[10px] text-muted-foreground">
                    {at ? `${at} · ` : ""}
                    {peer.isEditing
                      ? t("editor.presence.editing")
                      : cellId || peer.currentFileId
                        ? t("editor.presence.viewing")
                        : "online"}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
