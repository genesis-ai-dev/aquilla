import { useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppTooltip } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { formatRelativeTime, isStale } from "@/lib/time/relative";
import { RoleLabel } from "@/components/RoleLabel";
import { RoleSelect } from "@/components/RoleSelect";
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar";
import { MemberMultiAddRow, type MemberAddOutcome } from "@/components/MemberMultiAddRow";
import type { GrantScope } from "@/lib/access/grant-scope-sentence";
import type { MemberLaneAccess } from "@/lib/lanes/lane-access-choice";
import type { TargetLaneOption } from "@/hooks/useCurrentTargetLanes";
import type { UserSearchResult } from "@/hooks/useUserSearch";
import { useI18n } from "@/lib/i18n/I18nProvider";
import { ROLE } from "@/lib/frontier/roles";

export type { MemberAddOutcome } from "@/components/MemberMultiAddRow";

/** AQU-553: a single lane/file scope on a member. */
export interface MemberScopeValue {
  kind: "lane" | "file";
  value: string;
}

/**
 * AQU-553: project context needed to render per-member lane limits.
 * When passed to MembersPanel AND the caller can manage scopes (callerMaxRole
 * >= project lead), each member below maintainer gets a lane/file scope
 * editor, project leads included. Maintainers and above get no scope UI.
 * Absent = no scope UI (e.g. the org roster).
 */
export interface MembersPanelScopeConfig {
  /** Selectable lanes. `value: ""` is the default lane. */
  lanes: Array<{ value: string; label: string }>;
  /** Selectable files. */
  files: Array<{ id: string; name: string }>;
  /** Current scopes per member userId (absent / empty array = unscoped). */
  scopesByUser: Record<number, MemberScopeValue[]>;
  /**
   * Lanes this caller may grant. Null or omitted means every lane in `lanes`
   * (a maintainer, or a project lead who holds every lane). A list means only
   * those lanes; lanes outside it stay on the member and are not shown.
   */
  grantableLaneValues?: string[] | null;
  /** Persist a member's replace-set of scopes (issues the PUT). */
  onSave: (userId: number, scopes: MemberScopeValue[]) => Promise<void>;
}

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
  onAdd: (
    usernames: string[],
    role: number,
    laneAccess?: MemberLaneAccess,
  ) => Promise<MemberAddOutcome[]>;
  /**
   * AQU-780: map a whole-batch add failure (a thrown error where nothing
   * landed — e.g. a 403 owner-gate, a 429, or a 5xx) to the message shown
   * under the add row. Forwarded verbatim to MemberMultiAddRow. Without it,
   * the row falls back to a generic "Could not add — please try again.",
   * which hides the real cause (a non-owner was told to doubt the username
   * exists). Return null to suppress the inline message when the caller
   * surfaces the failure itself.
   */
  onAddBatchError?: (e: unknown) => string | null;
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
   * AQU-553 / AQU-2054: when provided (and callerMaxRole >= project lead),
   * renders a lane/file scope editor for members below maintainer, including
   * project leads. A caller who holds only some lanes can grant only those.
   * Maintainers and above are omitted.
   */
  scopeConfig?: MembersPanelScopeConfig;
  /**
   * Eligible-colleague rows offered by the add typeahead before any search —
   * e.g. org members without a direct grant. See UsernameTypeahead.
   */
  suggestions?: readonly UserSearchResult[];
  /** Shown when `suggestions` is provided but empty and nothing is typed. */
  emptySuggestionsHint?: string;
  /**
   * AQU-625: when set, the add-member search is disabled and this sentence is
   * shown. Share sets it when the member list is hidden from the caller.
   */
  searchDisabledReason?: string;
  /** AQU-1030: scope of the add row's grant sentence. Omit to keep the plain Add label. */
  grantScope?: GrantScope;
  /** AQU-1808: current target lanes the add row must choose among. */
  targetLanes?: readonly TargetLaneOption[];
}

export function MembersPanel({
  members,
  roleOptions,
  newMemberDefaultRole,
  onAdd,
  onAddBatchError,
  onRemove,
  onChangeRole,
  callerUserId,
  callerMaxRole,
  scopedUserSearch = true,
  scopeConfig,
  suggestions,
  emptySuggestionsHint,
  searchDisabledReason,
  grantScope,
  targetLanes,
}: MembersPanelProps) {
  const { t } = useI18n();
  // AQU-553: scope UI is shown only when project context is supplied and the
  // caller is a project lead or above. Per row, everyone below maintainer
  // gets the editor, project leads included (AQU-2054). A lane-limited caller
  // can grant only the lanes they hold. Someone who already has every lane
  // stays read-only for that caller, because narrowing them would take away
  // lanes the caller does not hold. Maintainers and above have no scope row.
  const canManageScopes =
    scopeConfig != null && callerMaxRole >= ROLE.PROJECT_LEAD;

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
          const grantable = scopeConfig?.grantableLaneValues ?? null;
          const targetHasLaneLimit = (scopeConfig?.scopesByUser[m.userId] ?? []).some(
            (scope) => scope.kind === "lane",
          );
          // A restricted caller cannot narrow someone who already holds every
          // lane: that set includes lanes the caller does not hold.
          const showEveryLaneLocked =
            canManageScopes &&
            scopeConfig != null &&
            grantable != null &&
            !targetHasLaneLimit &&
            m.roleLevel < ROLE.MAINTAINER;
          const showScopeEditor =
            canManageScopes &&
            scopeConfig != null &&
            !showEveryLaneLocked &&
            m.roleLevel < ROLE.MAINTAINER;
          return (
            <li key={m.userId} className="flex min-w-0 flex-col gap-2 overflow-x-hidden px-3 py-2">
              <div className="flex min-w-0 items-center gap-3">
              <UsernameWithAvatar userId={m.userId} username={m.username} className="min-w-0" />
              <RoleLabel name={m.roleName} />
              {m.source === "org" && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {t("org.membersPage.sourceViaOrg")}
                </span>
              )}
              {m.source === "group" && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {t("org.membersPanel.sourceViaGroup")}
                </span>
              )}
              {m.source === "creator" && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {t("org.memberAccessPanel.creatorGrantLabel")}
                </span>
              )}
              <LastActiveChip lastActiveAt={m.lastActiveAt} />
              <div className="ms-auto flex items-center gap-2">
                {onChangeRole && !m.isLocked && !isSelf && (
                  <RoleSelect
                    options={grantableRoles}
                    currentOption={
                      grantableRoles.some((r) => r.level === m.roleLevel)
                        ? null
                        : { level: m.roleLevel, name: m.roleName }
                    }
                    value={m.roleLevel}
                    onValueChange={(level) => void onChangeRole(m.username, level)}
                    size="sm"
                    aria-label={t("org.membersPage.changeRoleAria")}
                  />
                )}
                {!m.isLocked && !isSelf ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("org.teamDetail.removeAriaLabel", { name: m.username })}
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
              {showScopeEditor && scopeConfig != null && (
                <MemberScopesEditor
                  userId={m.userId}
                  config={scopeConfig}
                  current={scopeConfig.scopesByUser[m.userId] ?? []}
                />
              )}
              {showEveryLaneLocked && scopeConfig != null && (
                <LeadLaneLimits userId={m.userId} />
              )}
            </li>
          );
        })}
      </ul>

      <MemberMultiAddRow
        roleOptions={grantableRoles}
        defaultRole={newMemberDefaultRole}
        onAdd={onAdd}
        onBatchErrorMessage={onAddBatchError}
        excludedUserIds={existingUserIds}
        scopedUserSearch={scopedUserSearch}
        suggestions={searchDisabledReason != null ? undefined : suggestions}
        emptySuggestionsHint={emptySuggestionsHint}
        disabledReason={searchDisabledReason}
        grantScope={grantScope}
        targetLanes={targetLanes}
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
 * A lane-limited caller looking at someone who already holds every lane.
 * Narrowing that person would remove lanes the caller does not hold, so
 * this row stays read-only.
 */
function LeadLaneLimits({ userId }: { userId: number }) {
  const { t } = useI18n();

  return (
    <div
      data-testid={`member-lead-lanes-${userId}`}
      className="rounded border bg-muted/30 px-2 py-1.5 text-xs"
    >
      <p className="font-medium text-foreground">{t("org.membersPanel.leadEveryLane")}</p>
      <p className="text-muted-foreground">{t("org.membersPanel.leadLaneChangeHint")}</p>
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
  const { t } = useI18n();
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

  const grantable = config.grantableLaneValues ?? null;
  const laneOptions =
    grantable == null
      ? config.lanes
      : config.lanes.filter((lane) => grantable.includes(lane.value));

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    const laneList = [...lanes];
    const granted =
      grantable == null ? laneList : laneList.filter((value) => grantable.includes(value));
    const preserved =
      grantable == null ? [] : laneList.filter((value) => !grantable.includes(value));
    // An empty lane list means every lane. A caller who does not hold every
    // lane cannot produce that, including by unchecking the only lane they hold.
    if (grantable != null && granted.length === 0 && preserved.length === 0) {
      setSaveError(t("org.membersPanel.cannotGrantEveryLane"));
      setSaving(false);
      return;
    }
    const scopes: MemberScopeValue[] = [
      ...laneList.map((value): MemberScopeValue => ({ kind: "lane", value })),
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
          className={`h-3.5 w-3.5 shrink-0 text-muted-foreground ${
            expanded ? "rotate-90" : ""
          }`}
          aria-hidden
        />
        <span className="font-medium text-muted-foreground">
          {t("org.membersPanel.scopesToggleLabel")}
        </span>
        <span className="ms-auto truncate text-muted-foreground">
          {scopeSummary(savedLaneCount, savedFileCount)}
        </span>
      </button>
      {expanded && (
        <div id={bodyId} className="border-t px-2 pb-2 pt-2">
          <p className="mb-1.5 font-normal text-muted-foreground">
            {grantable == null
              ? t("org.membersPanel.leaveEmptyForFullAccess")
              : t("org.membersPanel.grantOnlyYourLanes")}
          </p>
          {laneOptions.length > 0 && (
            <fieldset className="mb-2">
              <legend className="mb-1 text-[10px] text-muted-foreground">
                {t("org.membersPanel.lanesLegend")}
              </legend>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {laneOptions.map((lane) => (
                  <label key={lane.value || "__default__"} className="flex items-center gap-1.5">
                    <Checkbox
                      checked={lanes.has(lane.value)}
                      onCheckedChange={() => setLanes((s) => toggle(s, lane.value))}
                      aria-label={t("org.membersPanel.laneCheckboxAriaLabel", { lane: lane.label })}
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
                {t("nav.dock.filesTab")}
              </legend>
              <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
                {config.files.map((file) => (
                  <label key={file.id} className="flex items-center gap-1.5">
                    <Checkbox
                      checked={files.has(file.id)}
                      onCheckedChange={() => setFiles((s) => toggle(s, file.id))}
                      aria-label={t("comments.scope.file", { file: file.name })}
                    />
                    <span className="truncate">{file.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="flex items-center gap-2">
            <Button onClick={handleSave} disabled={saving}>
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
