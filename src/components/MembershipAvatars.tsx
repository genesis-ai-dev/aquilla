import type { ProjectMember } from "@/lib/frontier/members"
import { UserChip } from "@/components/UserChip"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { resolveRoleName } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"

interface MembershipAvatarsProps {
  members: ProjectMember[]
  maxVisible?: number
}

export function MembershipAvatars({ members, maxVisible = 4 }: MembershipAvatarsProps) {
  const t = useT()
  if (members.length === 0) return null
  const visible = members.slice(0, maxVisible)
  const overflow = members.length - visible.length

  return (
    <AvatarGroup
      className="-space-x-1.5 *:data-[slot=avatar]:ring-background"
      aria-label={t("org.teamsList.memberCount", { count: members.length })}
    >
      {visible.map((m) => (
        <UserChip
          key={m.userId}
          userId={m.userId}
          username={m.username}
          size="sm"
          avatarOnly
          hint={resolveRoleName(t, m.role.name)}
        />
      ))}
      {overflow > 0 && (
        <AvatarGroupCount className="size-6 text-[10px] font-semibold">
          +{overflow}
        </AvatarGroupCount>
      )}
    </AvatarGroup>
  )
}
