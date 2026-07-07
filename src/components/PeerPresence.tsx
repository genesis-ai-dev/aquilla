import { useState } from "react"
import { Users } from "lucide-react"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { AppTooltip } from "@/components/ui/tooltip"
import type { PeerState } from "@/hooks/useFileSync"

interface PeerPresenceProps {
  peers: PeerState[]
}

export function PeerPresence({ peers }: PeerPresenceProps) {
  const [showPopover, setShowPopover] = useState(false)

  if (peers.length === 0) return null

  const visible = peers.slice(0, 5)
  const overflow = peers.length - 5

  return (
    <div className="relative">
      <AppTooltip content={`${peers.length} collaborator${peers.length !== 1 ? "s" : ""} online`}>
        <button
          className="flex items-center gap-0.5"
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
              <li key={peer.peerId} className="flex items-center gap-2 text-xs">
                <InitialsAvatar name={peer.username} size="xs" color={peer.color} />
                <span className="truncate">{peer.username}</span>
                {peer.currentFileId && (
                  <span className="ml-auto text-[10px] text-muted-foreground">editing</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
