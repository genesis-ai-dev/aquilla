import { useState } from "react"
import { Users } from "lucide-react"
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

  function getInitials(username: string): string {
    const trimmed = username.trim()
    if (!trimmed) return "?"
    const parts = trimmed.split(/\s+/)
    if (parts.length === 1) return trimmed[0].toUpperCase()
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  }

  return (
    <div className="relative">
      <AppTooltip content={`${peers.length} collaborator${peers.length !== 1 ? "s" : ""} online`}>
        <button
          className="flex items-center gap-0.5"
          onClick={() => setShowPopover(!showPopover)}
        >
        <div className="flex -space-x-1.5">
          {visible.map((peer) => (
            <div
              key={peer.peerId}
              className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-white"
              style={{ backgroundColor: peer.color }}
            >
              {getInitials(peer.username)}
            </div>
          ))}
          {overflow > 0 && (
            <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-semibold text-muted-foreground">
              +{overflow}
            </div>
          )}
        </div>
        </button>
      </AppTooltip>

      {showPopover && (
        <div className="absolute right-0 bottom-full mb-2 z-40 w-56 rounded border bg-background p-2 shadow-md">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Users className="h-3 w-3" />
            Online ({peers.length})
          </div>
          <ul className="space-y-1">
            {peers.map((peer) => (
              <li key={peer.peerId} className="flex items-center gap-2 text-xs">
                <div
                  className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold text-white"
                  style={{ backgroundColor: peer.color }}
                >
                  {getInitials(peer.username)}
                </div>
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
