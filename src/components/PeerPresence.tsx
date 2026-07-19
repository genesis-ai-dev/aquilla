import { useState } from "react"
import { Users } from "lucide-react"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
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
    <Popover open={showPopover} onOpenChange={setShowPopover}>
      <AppTooltip content={`${peers.length} collaborator${peers.length !== 1 ? "s" : ""} online`}>
        <PopoverTrigger
          render={
            <button
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-background/80 px-1.5 pr-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
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
              <span className="hidden max-w-24 truncate leading-none sm:inline">{label}</span>
            </button>
          }
        />
      </AppTooltip>

      <PopoverContent side="top" align="end" sideOffset={8} className="w-56 gap-0 p-2">
        <PopoverTitle className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Users className="h-3 w-3" />
          Online ({peers.length})
        </PopoverTitle>
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
      </PopoverContent>
    </Popover>
  )
}
