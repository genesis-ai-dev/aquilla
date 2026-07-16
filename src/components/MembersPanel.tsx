import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatRelativeTime, isStale } from "@/lib/time/relative";
import { RoleLabel } from "@/components/RoleLabel";
import { roleDisplayText } from "@/lib/frontier/roles";
import { UsernameTypeahead, type RecipientValue } from "@/components/UsernameTypeahead";

/** AQU-553: a single lane/file scope on a member. */
export interface MemberScopeValue {
  kind: "lane" | "file";
  value: string;
}

/**
 * AQU-553: project context needed to render the per-member scopes editor.
 * When passed to MembersPanel AND the caller can manage scopes (callerMaxRole
 * >= 500), each scopable member (roleLevel < 500) gets a lane/file scope
 * editor. Absent = no scope UI (e.g. the org-level roster, which has no lanes).
 */
export interface MembersPanelScopeConfig {
  /** Selectable lanes. `value: ""` is the default lane. */
  lanes: Array<{ value: string; label: string }>;
  /** Selectable files. */
  files: Array<{ id: string; name: string }>;
  /** Current scopes per member userId (absent / empty array = unscoped). */
  scopesByUser: Record<number, MemberScopeValue[]>;
  /** Persist a member's replace-set of scopes (issues the PUT). */
  onSave: (userId: number, scopes: MemberScopeValue[]) => Promise<void>;
}

/** Minimum role that may edit scopes AND is itself unscopable (leads+). */
const SCOPE_MANAGE_MIN_ROLE = 500;

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
  /**
   * Initial value of the "role to grant" picker when adding a NEW member.
   * This is local UI state only — it is never persisted and has no effect
   * on any existing member's role. There is no project-wide default role;
   * every member's effective role comes solely from their own explicit
   * grant (see AD-12 max-wins resolver in project-permissions.ts).
   */
  newMemberDefaultRole: number;
  onAdd: (username: string, role: number) => Promise<{ ok: boolean; error?: string }>;
  onRemove: (userId: number) => Promise<void>;
  onChangeRole?: (username: string, role: number) => Promise<void>;
  /** Caller's own user id, used to block self-edit affordances. Pass null when
   * unknown — the server still rejects self-grants. */
  callerUserId: number | null;
  /** Highest role the caller can grant (caps the role dropdown). */
  callerMaxRole: number;
  /** Disable for org membership, where search should find any Aquilla user. */
  scopedUserSearch?: boolean;
  /**
   * AQU-553: when provided (and callerMaxRole >= 500), renders a per-member
   * lane/file scopes editor for scopable members (roleLevel < 500).
   */
  scopeConfig?: MembersPanelScopeConfig;
}

export function MembersPanel({
  members,
  roleOptions,
  newMemberDefaultRole,
  onAdd,
  onRemove,
  onChangeRole,
  callerUserId,
  callerMaxRole,
  scopedUserSearch = true,
  scopeConfig,
}: MembersPanelProps) {
  // AQU-553: the scopes editor is shown only when project context is supplied
  // AND the caller is a lead+ (500). Leads themselves are never scopable, so
  // per-row the editor is further gated on the member being below 500.
  const canManageScopes =
    scopeConfig != null && callerMaxRole >= SCOPE_MANAGE_MIN_ROLE;
  // Typeahead-mode-only here. Email-mode is for project-link invites
  // (handled in MultiProjectInviteDialog / SharePanel), not direct
  // org-membership grants — `addOrgMember` requires a real Frontier
  // user id, which we don't have for an unsigned-up email yet.
  const [recipient, setRecipient] = useState<RecipientValue>({
    mode: "username",
    raw: "",
  });
  const [role, setRole] = useState(newMemberDefaultRole);
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
    setRole(newMemberDefaultRole);
  }

  const grantableRoles = roleOptions.filter((r) => r.level <= callerMaxRole);
  const existingUserIds = members.map((m) => m.userId);

  return (
    <div className="flex flex-col gap-4">
      <ul className="max-h-[50vh] divide-y overflow-x-hidden overflow-y-auto overscroll-contain rounded border">
        {members.map((m) => {
          const isSelf = callerUserId !== null && m.userId === callerUserId;
          // AQU-553: leads+ (>=500) must stay unscoped, so the editor only
          // renders for members below that floor.
          const showScopes =
            canManageScopes && scopeConfig != null && m.roleLevel < SCOPE_MANAGE_MIN_ROLE;
          return (
            <li key={m.userId} className="flex min-w-0 flex-col gap-2 overflow-x-hidden px-3 py-2">
              <div className="flex min-w-0 items-center gap-3">
              <span className="min-w-0 truncate font-medium">{m.username}</span>
              <RoleLabel name={m.roleName} className="text-xs text-muted-foreground" />
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
                        : [{ value: String(m.roleLevel), label: roleDisplayText(m.roleName) }]),
                      ...grantableRoles.map((r) => ({ value: String(r.level), label: roleDisplayText(r.name) })),
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
                          <SelectItem key={r.level} value={String(r.level)}>
                            <RoleLabel name={r.name} />
                          </SelectItem>
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
                  <AppTooltip content={m.lockedHint}>
                    <span className="text-[10px] text-muted-foreground">
                      {m.lockedHint ?? ""}
                    </span>
                  </AppTooltip>
                )}
              </div>
              </div>
              {showScopes && scopeConfig != null && (
                <MemberScopesEditor
                  userId={m.userId}
                  config={scopeConfig}
                  current={scopeConfig.scopesByUser[m.userId] ?? []}
                />
              )}
            </li>
          );
        })}
      </ul>

      <div className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_max-content_max-content] sm:items-start">
          <div className="min-w-0">
            <UsernameTypeahead
              value={recipient}
              onChange={setRecipient}
              disabled={adding}
              showModeToggle={false}
              placeholder={{ username: "Aquilla username" }}
              excludedUserIds={existingUserIds}
              scopedSearch={scopedUserSearch}
            />
          </div>
          <Select
            items={grantableRoles.map((r) => ({ value: String(r.level), label: roleDisplayText(r.name) }))}
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
                  <SelectItem key={r.level} value={String(r.level)}>
                    <RoleLabel name={r.name} />
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            className="sm:whitespace-nowrap"
            onClick={handleAdd}
            disabled={adding || !recipient.raw.trim()}
          >
            Add
          </Button>
        </div>
        {addError && <p className="text-xs text-destructive">{addError}</p>}
      </div>
    </div>
  );
}

/**
 * AQU-553: per-member lane/file scope editor. Renders a checkbox list of the
 * project's lanes and files; the member may write target-side content only on
 * checked lanes AND only in checked files (empty selection for a kind = no
 * restriction for that kind). Save issues the replace-set PUT via config.onSave.
 *
 * "Unscoped" (no checkboxes ticked at all) is the default and means the member
 * writes across every lane and file their role allows — identical to a member
 * with no scope rows.
 */
function MemberScopesEditor({
  userId,
  config,
  current,
}: {
  userId: number;
  config: MembersPanelScopeConfig;
  current: MemberScopeValue[];
}) {
  const initialLanes = new Set(
    current.filter((s) => s.kind === "lane").map((s) => s.value),
  );
  const initialFiles = new Set(
    current.filter((s) => s.kind === "file").map((s) => s.value),
  );
  const [lanes, setLanes] = useState<Set<string>>(initialLanes);
  const [files, setFiles] = useState<Set<string>>(initialFiles);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function toggle(set: Set<string>, value: string): Set<string> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    const scopes: MemberScopeValue[] = [
      ...[...lanes].map((value): MemberScopeValue => ({ kind: "lane", value })),
      ...[...files].map((value): MemberScopeValue => ({ kind: "file", value })),
    ];
    try {
      await config.onSave(userId, scopes);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save scopes");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      data-testid={`member-scopes-${userId}`}
      className="rounded border bg-muted/30 p-2 text-xs"
    >
      <p className="mb-1.5 font-medium text-muted-foreground">
        Scopes <span className="font-normal">(leave empty for full access)</span>
      </p>
      {config.lanes.length > 0 && (
        <fieldset className="mb-2">
          <legend className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Lanes
          </legend>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {config.lanes.map((lane) => (
              <label key={lane.value || "__default__"} className="flex items-center gap-1.5">
                <Checkbox
                  checked={lanes.has(lane.value)}
                  onCheckedChange={() => setLanes((s) => toggle(s, lane.value))}
                  aria-label={`Lane ${lane.label}`}
                />
                <span>{lane.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {config.files.length > 0 && (
        <fieldset className="mb-2">
          <legend className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            Files
          </legend>
          <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
            {config.files.map((file) => (
              <label key={file.id} className="flex items-center gap-1.5">
                <Checkbox
                  checked={files.has(file.id)}
                  onCheckedChange={() => setFiles((s) => toggle(s, file.id))}
                  aria-label={`File ${file.name}`}
                />
                <span className="truncate">{file.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save scopes"}
        </Button>
        {saveError && <span className="text-destructive">{saveError}</span>}
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
    <AppTooltip
      content={
        stale
          ? "No recent activity; consider whether this membership is still needed"
          : "Last project-context activity in this org"
      }
    >
      <span
        className={`rounded px-1.5 py-0.5 text-[10px] ${
          stale
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
            : "bg-muted text-muted-foreground"
        }`}
      >
        {stale ? "stale · " : ""}
        {label}
      </span>
    </AppTooltip>
  );
}
