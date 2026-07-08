import { useState } from "react"
import { Users } from "lucide-react"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { AppTooltip } from "@/components/ui/tooltip"
import type { ProjectPresencePeer } from "@/lib/sync/presence-store"

interface PeerPresenceProps {
  peers: ProjectPresencePeer[]
  onJumpToPeer?: (peer: ProjectPresencePeer) => void
}

export function PeerPresence({ peers, onJumpToPeer }: PeerPresenceProps) {
  const [showPopover, setShowPopover] = useState(false)

  if (peers.length === 0) return null

  const visible = peers.slice(0, 5)
  const overflow = peers.length - 5
  const firstPeer = peers[0]
  const label = peers.length === 1 && firstPeer ? firstPeer.username : `${peers.length} online`

  return (
    <div className="relative">
      <AppTooltip content={`${peers.length} collaborator${peers.length !== 1 ? "s" : ""} online`}>
        <button
          className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          onClick={() => setShowPopover(!showPopover)}
        >
          <AvatarGroup className="-space-x-1.5 *:data-[slot=avatar]:ring-background">
            {visible.map((peer) => (
              <InitialsAvatar
                key={peer.peerId}
                name={peer.username}
                size="sm"
                color={peer.color}
              />
            ))}
            {overflow > 0 && (
              <AvatarGroupCount className="size-6 text-[10px] font-semibold">
                +{overflow}
              </AvatarGroupCount>
            )}
          </AvatarGroup>
          <span className="hidden max-w-28 truncate sm:inline">{label}</span>
        </button>
      </AppTooltip>

      {showPopover && (
        <div className="absolute right-0 bottom-full z-40 mb-2 w-56 rounded border bg-background p-2 shadow-md">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Users className="h-3 w-3" />
            Online ({peers.length})
          </div>
          <ul className="flex flex-col gap-1">
            {peers.map((peer) => (
              <li key={peer.peerId}>
                <button
                  type="button"
                  disabled={!peer.currentFileId && !peer.focusedCell}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
                  onClick={() => {
                    if (!peer.currentFileId && !peer.focusedCell) return
                    onJumpToPeer?.(peer)
                    setShowPopover(false)
                  }}
                >
                <InitialsAvatar name={peer.username} size="xs" color={peer.color} />
                <span className="truncate">{peer.username}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {peer.focusedCell ? "editing" : peer.currentFileId ? "viewing" : "online"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
