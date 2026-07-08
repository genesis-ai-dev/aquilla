import type { ProjectMember } from "@/lib/frontier/members"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { AppTooltip } from "@/components/ui/tooltip"

interface MembershipAvatarsProps {
  members: ProjectMember[]
  maxVisible?: number
}

export function MembershipAvatars({ members, maxVisible = 4 }: MembershipAvatarsProps) {
  if (members.length === 0) return null
  const visible = members.slice(0, maxVisible)
  const overflow = members.length - visible.length

  return (
    <AvatarGroup
      className="-space-x-1.5 *:data-[slot=avatar]:ring-background"
      aria-label={`${members.length} member${members.length !== 1 ? "s" : ""}`}
    >
      {visible.map((m) => (
        <AppTooltip key={m.userId} content={`${m.username} (${m.role.name})`}>
          <InitialsAvatar name={m.username} size="sm" singleInitial />
        </AppTooltip>
      ))}
      {overflow > 0 && (
        <AvatarGroupCount className="size-6 text-[10px] font-semibold">
          +{overflow}
        </AvatarGroupCount>
      )}
    </AvatarGroup>
  )
}
