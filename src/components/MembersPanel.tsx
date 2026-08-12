import { useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { formatRelativeTime, isStale } from "@/lib/time/relative";
import { RoleLabel } from "@/components/RoleLabel";
import { resolveRoleName } from "@/lib/frontier/roles";
import { useT } from "@/lib/i18n/I18nProvider";
import { MemberMultiAddRow, type MemberAddOutcome } from "@/components/MemberMultiAddRow";
import type { UserSearchResult } from "@/hooks/useUserSearch";

export type { MemberAddOutcome } from "@/components/MemberMultiAddRow";

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
  // No `description` field — MembersPanel never renders one. (It used to be
  // declared here even though unused; dropped in AQU-832 wave 3/WS-08 so this
  // interface doesn't force every caller — including roles.ts's `RoleOption`,
  // which now carries `descriptionKey` instead of a plain string — to shim a
  // field nothing reads.)
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
  /**
   * AQU-734: grant the chosen role to a batch of people in ONE call. Returns a
   * per-person outcome in any order; the panel drops the people who succeeded
   * and keeps the ones who failed staged, naming them. Implementations send a
   * single batch request (never a client-side fan-out).
   */
  onAdd: (usernames: string[], role: number) => Promise<MemberAddOutcome[]>;
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
  /**
   * Eligible-colleague rows offered by the add typeahead before any search —
   * e.g. org members without a direct grant. See UsernameTypeahead.
   */
  suggestions?: readonly UserSearchResult[];
  /** Shown when `suggestions` is provided but empty and nothing is typed. */
  emptySuggestionsHint?: string;
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
  suggestions,
  emptySuggestionsHint,
}: MembersPanelProps) {
  // AQU-553: the scopes editor is shown only when project context is supplied
  // AND the caller is a lead+ (500). Leads themselves are never scopable, so
  // per-row the editor is further gated on the member being below 500.
  const t = useT();
  const canManageScopes =
    scopeConfig != null && callerMaxRole >= SCOPE_MANAGE_MIN_ROLE;

  const grantableRoles = roleOptions.filter((r) => r.level <= callerMaxRole);
  // People in `suggestions` stay searchable/checkable even when they appear in
  // the roster — an org-access-only member is still grantable an explicit
  // direct role (AQU-672 eligibility). Everyone else already listed is hidden
  // from the typeahead as "already a member."
  const suggestionIds = new Set((suggestions ?? []).map((u) => u.id));
  const existingUserIds = members
    .map((m) => m.userId)
    .filter((id) => !suggestionIds.has(id));

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
              <div className="ms-auto flex items-center gap-2">
                {onChangeRole && !m.isLocked && !isSelf && (
                  <Select
                    items={[
                      // Current role may sit above the caller's grantable cap
                      // (e.g. owner 700); include it so the closed trigger
                      // renders the role name instead of the raw level.
                      ...(grantableRoles.some((r) => r.level === m.roleLevel)
                        ? []
                        : [{ value: String(m.roleLevel), label: resolveRoleName(t, m.roleName) }]),
                      ...grantableRoles.map((r) => ({ value: String(r.level), label: resolveRoleName(t, r.name) })),
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

      <MemberMultiAddRow
        roleOptions={grantableRoles}
        defaultRole={newMemberDefaultRole}
        onAdd={onAdd}
        excludedUserIds={existingUserIds}
        scopedUserSearch={scopedUserSearch}
        suggestions={suggestions}
        emptySuggestionsHint={emptySuggestionsHint}
      />
    </div>
  );
}

/**
 * AQU-645: build the compact scope summary shown on the collapsed header, so a
 * member's access is scannable without expanding. "Full access" when nothing is
 * scoped, otherwise a per-kind count like "2 lanes · 1 file" (each kind
 * pluralized, kinds with zero selected omitted).
 */
function scopeSummary(laneCount: number, fileCount: number): string {
  if (laneCount === 0 && fileCount === 0) return "Full access";
  const parts: string[] = [];
  if (laneCount > 0) parts.push(`${laneCount} lane${laneCount === 1 ? "" : "s"}`);
  if (fileCount > 0) parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"}`);
  return parts.join(" · ");
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
 *
 * AQU-645: collapsed by default. The header row (a keyboard-accessible button)
 * shows a scope summary of the member's *saved* access and toggles the editor
 * body. Expand/collapse is local to this instance, so opening one member's
 * scopes never affects another's.
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
  // AQU-645: the collapsed summary reflects the last *persisted* selection, not
  // in-flight edits — it starts from `current` and only advances on a
  // successful save, so an expand-toggle-collapse without saving keeps showing
  // the real access.
  const [savedLaneCount, setSavedLaneCount] = useState(initialLanes.size);
  const [savedFileCount, setSavedFileCount] = useState(initialFiles.size);
  const [expanded, setExpanded] = useState(false);
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
      setSavedLaneCount(lanes.size);
      setSavedFileCount(files.size);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save scopes");
    } finally {
      setSaving(false);
    }
  }

  const bodyId = `member-scopes-body-${userId}`;

  return (
    <div
      data-testid={`member-scopes-${userId}`}
      className="rounded border bg-muted/30 text-xs"
    >
      <button
        type="button"
        data-testid={`member-scopes-toggle-${userId}`}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-start"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
          aria-hidden
        />
        <span className="font-medium text-muted-foreground">Scopes</span>
        <span className="ms-auto truncate text-muted-foreground">
          {scopeSummary(savedLaneCount, savedFileCount)}
        </span>
      </button>
      {expanded && (
        <div id={bodyId} className="border-t px-2 pb-2 pt-2">
          <p className="mb-1.5 font-normal text-muted-foreground">
            Leave empty for full access.
          </p>
          {config.lanes.length > 0 && (
            <fieldset className="mb-2">
              <legend className="mb-1 text-[10px] text-muted-foreground">
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
              <legend className="mb-1 text-[10px] text-muted-foreground">
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
      )}
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
