import type { ProjectMember } from "@/lib/frontier/members";

interface MembershipAvatarsProps {
  members: ProjectMember[];
  maxVisible?: number;
}

function getInitial(username: string): string {
  const trimmed = username.trim();
  if (!trimmed) return "?";
  return trimmed[0].toUpperCase();
}

// Stable color hash per username — keeps avatars visually consistent across
// re-renders and across the dashboard / SharePanel surfaces.
function colorFor(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) {
    hash = (hash << 5) - hash + username.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 50%)`;
}

export function MembershipAvatars({ members, maxVisible = 4 }: MembershipAvatarsProps) {
  if (members.length === 0) return null;
  const visible = members.slice(0, maxVisible);
  const overflow = members.length - visible.length;

  return (
    <div
      className="flex -space-x-1.5"
      title={`${members.length} member${members.length !== 1 ? "s" : ""}`}
    >
      {visible.map((m) => (
        <div
          key={m.userId}
          title={`${m.username} (${m.role.name})`}
          className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold text-white"
          style={{ backgroundColor: colorFor(m.username) }}
        >
          {getInitial(m.username)}
        </div>
      ))}
      {overflow > 0 && (
        <div className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-semibold text-muted-foreground">
          +{overflow}
        </div>
      )}
    </div>
  );
}
