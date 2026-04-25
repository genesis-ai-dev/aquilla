import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface MembersPanelMember {
  userId: number;
  username: string;
  roleLevel: number;
  roleName: string;
  source: "override" | "creator" | "org" | "owner-of-org";
  /** True when removing this row is not possible from this UI surface. */
  isLocked: boolean;
  lockedHint?: string;
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
  const [username, setUsername] = useState("");
  const [role, setRole] = useState(defaultRole);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAdd() {
    if (!username.trim()) return;
    setAdding(true);
    setAddError(null);
    const result = await onAdd(username.trim(), role);
    setAdding(false);
    if (!result.ok) {
      setAddError(result.error ?? "Could not add user");
      return;
    }
    setUsername("");
    setRole(defaultRole);
  }

  const grantableRoles = roleOptions.filter((r) => r.level <= callerMaxRole);

  return (
    <div className="space-y-4">
      <ul className="divide-y rounded border">
        {members.map((m) => {
          const isSelf = callerUserId !== null && m.userId === callerUserId;
          return (
            <li key={m.userId} className="flex items-center gap-3 px-3 py-2">
              <span className="font-medium">{m.username}</span>
              <span className="text-xs text-muted-foreground">{m.roleName}</span>
              {m.source === "org" && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">via org</span>
              )}
              {m.source === "creator" && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">creator</span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {onChangeRole && !m.isLocked && !isSelf && (
                  <select
                    className="rounded border bg-background px-2 py-1 text-xs"
                    value={m.roleLevel}
                    onChange={(e) => onChangeRole(m.username, parseInt(e.target.value, 10))}
                  >
                    {grantableRoles.map((r) => (
                      <option key={r.level} value={r.level}>{r.name}</option>
                    ))}
                  </select>
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
          <Input
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={adding}
            autoComplete="off"
          />
          <select
            className="rounded border bg-background px-2 text-sm"
            value={role}
            onChange={(e) => setRole(parseInt(e.target.value, 10))}
            disabled={adding}
          >
            {grantableRoles.map((r) => (
              <option key={r.level} value={r.level}>{r.name}</option>
            ))}
          </select>
          <Button onClick={handleAdd} disabled={adding || !username.trim()}>
            Add
          </Button>
        </div>
        {addError && <p className="text-xs text-destructive">{addError}</p>}
      </div>
    </div>
  );
}
