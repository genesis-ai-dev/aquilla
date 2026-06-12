import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatRelativeTime, isStale } from "@/lib/time/relative";
import { UsernameTypeahead, type RecipientValue } from "@/components/UsernameTypeahead";

export interface MembersPanelMember {
  userId: number;
  username: string;
  roleLevel: number;
  roleName: string;
  source: "override" | "group" | "creator" | "org" | "owner-of-org";
  /** True when removing this row is not possible from this UI surface. */
  isLocked: boolean;
  lockedHint?: string;
  /** Optional ISO timestamp of last project-context activity in this org.
   * When provided, the panel renders a "Last active X ago" hint and
   * highlights stale (>30d) members. Absence renders no hint. */
  lastActiveAt?: string | null;
}

export interface MembersPanelRoleOption {
  level: number;
  name: string;
  description: string;
}

interface MembersPanelProps {
  members: MembersPanelMember[];
  roleOptions: MembersPanelRoleOption[];
  defaultRole: number;
  onAdd: (username: string, role: number) => Promise<{ ok: boolean; error?: string }>;
  onRemove: (userId: number) => Promise<void>;
  onChangeRole?: (username: string, role: number) => Promise<void>;
  /** Caller's own user id, used to block self-edit affordances. Pass null when
   * unknown — the server still rejects self-grants. */
  callerUserId: number | null;
  /** Highest role the caller can grant (caps the role dropdown). */
  callerMaxRole: number;
}

export function MembersPanel({
  members,
  roleOptions,
  defaultRole,
  onAdd,
  onRemove,
  onChangeRole,
  callerUserId,
  callerMaxRole,
}: MembersPanelProps) {
  // Typeahead-mode-only here. Email-mode is for project-link invites
  // (handled in MultiProjectInviteDialog / SharePanel), not direct
  // org-membership grants — `addOrgMember` requires a real Frontier
  // user id, which we don't have for an unsigned-up email yet.
  const [recipient, setRecipient] = useState<RecipientValue>({
    mode: "username",
    raw: "",
  });
  const [role, setRole] = useState(defaultRole);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAdd() {
    const trimmed = recipient.raw.trim();
    if (!trimmed) return;
    setAdding(true);
    setAddError(null);
    const result = await onAdd(trimmed, role);
    setAdding(false);
    if (!result.ok) {
      setAddError(result.error ?? "Could not add user");
      return;
    }
    setRecipient({ mode: "username", raw: "" });
    setRole(defaultRole);
  }

  const grantableRoles = roleOptions.filter((r) => r.level <= callerMaxRole);

  return (
    <div className="flex flex-col gap-4">
      <ul className="max-h-[50vh] divide-y overflow-x-hidden overflow-y-auto overscroll-contain rounded border">
        {members.map((m) => {
          const isSelf = callerUserId !== null && m.userId === callerUserId;
          return (
            <li key={m.userId} className="flex min-w-0 items-center gap-3 overflow-x-hidden px-3 py-2">
              <span className="min-w-0 truncate font-medium">{m.username}</span>
              <span className="text-xs text-muted-foreground">{m.roleName}</span>
              {m.source === "org" && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">via org</span>
              )}
              {m.source === "group" && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">via group</span>
              )}
              {m.source === "creator" && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">creator</span>
              )}
              <LastActiveChip lastActiveAt={m.lastActiveAt} />
              <div className="ml-auto flex items-center gap-2">
                {onChangeRole && !m.isLocked && !isSelf && (
                  <Select
                    items={[
                      // Current role may sit above the caller's grantable cap
                      // (e.g. owner 700); include it so the closed trigger
                      // renders the role name instead of the raw level.
                      ...(grantableRoles.some((r) => r.level === m.roleLevel)
                        ? []
                        : [{ value: String(m.roleLevel), label: m.roleName }]),
                      ...grantableRoles.map((r) => ({ value: String(r.level), label: r.name })),
                    ]}
                    value={String(m.roleLevel)}
                    onValueChange={(v) => onChangeRole(m.username, parseInt(v ?? "", 10))}
                  >
                    <SelectTrigger size="sm" aria-label="Change role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {grantableRoles.map((r) => (
                          <SelectItem key={r.level} value={String(r.level)}>{r.name}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
                {!m.isLocked && !isSelf ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${m.username}`}
                    onClick={() => onRemove(m.userId)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : (
                  <span className="text-[10px] text-muted-foreground" title={m.lockedHint}>
                    {m.lockedHint ?? ""}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="flex-1">
            <UsernameTypeahead
              value={recipient}
              onChange={setRecipient}
              disabled={adding}
              showModeToggle={false}
              placeholder={{ username: "Aquilla username" }}
            />
          </div>
          <Select
            items={grantableRoles.map((r) => ({ value: String(r.level), label: r.name }))}
            value={String(role)}
            onValueChange={(v) => setRole(parseInt(v ?? "", 10))}
            disabled={adding}
          >
            <SelectTrigger aria-label="Role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {grantableRoles.map((r) => (
                  <SelectItem key={r.level} value={String(r.level)}>{r.name}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button onClick={handleAdd} disabled={adding || !recipient.raw.trim()}>
            Add
          </Button>
        </div>
        {addError && <p className="text-xs text-destructive">{addError}</p>}
      </div>
    </div>
  );
}

/**
 * "Last active X ago" chip with a stale highlight past 30 days. Absent
 * timestamps render nothing — that's the "we haven't seen activity yet
 * since tracking landed" state, distinct from "we haven't seen them in
 * a long time."
 */
function LastActiveChip({ lastActiveAt }: { lastActiveAt: string | null | undefined }) {
  if (lastActiveAt == null) return null;
  const label = formatRelativeTime(lastActiveAt);
  if (!label) return null;
  const stale = isStale(lastActiveAt);
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] ${
        stale
          ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
          : "bg-muted text-muted-foreground"
      }`}
      title={
        stale
          ? "No recent activity — consider whether this membership is still needed"
          : "Last project-context activity in this org"
      }
    >
      {stale ? "stale · " : ""}
      {label}
    </span>
  );
}
