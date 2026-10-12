import { useState } from "react";
import { LaneAccessFields } from "@/components/LaneAccessFields";
import { ROLE } from "@/lib/frontier/roles";
import {
  laneChoiceReady,
  needsLaneChoice,
  toMemberLaneAccess,
  type LaneAccessChoice,
  type MemberLaneAccess,
} from "@/lib/lanes/lane-access-choice";
import type { TargetLaneOption } from "@/hooks/useCurrentTargetLanes";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GrantScopeNotice } from "@/components/GrantScopeNotice";
import { RoleSelect } from "@/components/RoleSelect";
import { UsernameTypeahead, type RecipientValue } from "@/components/UsernameTypeahead";
import { toast } from "@/components/ui/toast";
import type { UserSearchResult } from "@/hooks/useUserSearch";
import { useI18n } from "@/lib/i18n/I18nProvider";
import {
  describeGrant,
  grantButtonLabel,
  type GrantScope,
} from "@/lib/access/grant-scope-sentence";

/**
 * AQU-734: per-person outcome of a batch add, mirrored from the server's
 * non-atomic `results`. `error` is a human-readable reason for a single failed
 * grant (already a member, unknown user, insufficient permission) — the row
 * names only the people who failed and keeps them staged for a retry.
 */
export interface MemberAddOutcome {
  username: string;
  ok: boolean;
  error?: string;
}

/** AQU-734: a person staged to be added. `id` is set when picked from search. */
interface StagedRecipient {
  username: string;
  id?: number;
}

export interface MemberAddRoleOption {
  level: number;
  name: string;
}

const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

interface MemberMultiAddRowProps {
  /** Roles offered in the picker — pass them already capped to the caller. */
  roleOptions: readonly MemberAddRoleOption[];
  /** Initial value of the role picker (local UI state only). */
  defaultRole: number;
  /**
   * AQU-734: grant the chosen role to a batch of people in ONE call. Returns a
   * per-person outcome in any order; the row drops the people who succeeded
   * and keeps the ones who failed staged, naming them. Implementations send a
   * single batch request (never a client-side fan-out).
   */
  onAdd: (
    usernames: string[],
    role: number,
    laneAccess?: MemberLaneAccess,
  ) => Promise<MemberAddOutcome[]>;
  /** User ids hidden from search results / suggestions (already members). */
  excludedUserIds?: readonly number[];
  /** Disable for org membership, where search should find any Aquilla user. */
  scopedUserSearch?: boolean;
  /** Eligible-colleague rows offered before any search (see UsernameTypeahead). */
  suggestions?: readonly UserSearchResult[];
  /** Shown when `suggestions` is provided but empty and nothing is typed. */
  emptySuggestionsHint?: string;
  /** Fires as an Add attempt starts — lets the parent clear its own error UI. */
  onAddStart?: () => void;
  /**
   * Map a whole-batch failure (thrown, nothing landed) to the message shown
   * under the row. Return null to render nothing — for parents that surface
   * the failure themselves (e.g. the AQU-560 permission alert). Absent = a
   * generic retry message.
   */
  onBatchErrorMessage?: (e: unknown) => string | null;
  disabled?: boolean;
  buttonSize?: "sm" | "default";
  /**
   * AQU-1030: when set, a live sentence above Add states who will join as
   * which role at this scope, the button echoes the scope, and a success
   * toast repeats the sentence for the people who landed.
   */
  grantScope?: GrantScope;
  /**
   * AQU-1808: current target lanes. When this list is non-empty and the
   * chosen role is below project lead, Add stays disabled until the sharer
   * picks every lane or names the ones this person may use.
   */
  targetLanes?: readonly TargetLaneOption[];
}

/**
 * AQU-734: the staged multi-add row shared by every "add people" surface —
 * chips of staged people above a typeahead (checkbox rows), a role picker,
 * and a single batch Add. Extracted from MembersPanel so the per-project
 * members page and the Share modal render the exact same affordance.
 */
export function MemberMultiAddRow({
  roleOptions,
  defaultRole,
  onAdd,
  excludedUserIds = [],
  scopedUserSearch = true,
  suggestions,
  emptySuggestionsHint,
  onAddStart,
  onBatchErrorMessage,
  disabled = false,
  buttonSize = "default",
  grantScope,
  targetLanes = [],
}: MemberMultiAddRowProps) {
  const { t, locale } = useI18n();
  // Typeahead-mode-only here. Email-mode is for project-link invites
  // (handled in MultiProjectInviteDialog / SharePanel), not direct grants —
  // granting requires a real Frontier user id, which we don't have for an
  // unsigned-up email yet.
  const [recipient, setRecipient] = useState<RecipientValue>({
    mode: "username",
    raw: "",
  });
  // AQU-734: people staged to be granted the role in a single batch Add. The
  // search box (`recipient`) only holds the current query; picking checkboxes
  // or pressing Enter accumulates people here so they survive new searches.
  const [staged, setStaged] = useState<StagedRecipient[]>([]);
  const [role, setRole] = useState(defaultRole);
  const [laneChoice, setLaneChoice] = useState<LaneAccessChoice | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  function stageOne(person: StagedRecipient) {
    setStaged((prev) =>
      prev.some((s) => sameName(s.username, person.username)) ? prev : [...prev, person],
    );
  }

  function toggleStaged(person: StagedRecipient) {
    setStaged((prev) =>
      prev.some((s) => sameName(s.username, person.username))
        ? prev.filter((s) => !sameName(s.username, person.username))
        : [...prev, person],
    );
    setAddError(null);
  }

  function removeStaged(username: string) {
    setStaged((prev) => prev.filter((s) => !sameName(s.username, username)));
    setAddError(null);
  }

  function stageTyped() {
    const name = recipient.raw.trim();
    if (!name) return;
    stageOne({ username: name });
    setRecipient({ mode: "username", raw: "" });
    setAddError(null);
  }

  /**
   * The people a press of Add will grant. When chips are staged, the input is a
   * search filter and its leftover text is ignored — what you see staged is
   * what gets added. Only with no chips is the typed text treated as a
   * free-typed username, so a single typed name still adds without an explicit
   * Enter (matching the pre-multi-select behavior). To add a free-typed name
   * alongside checked people, press Enter to stage it as a chip first.
   */
  function effectiveStaged(): StagedRecipient[] {
    if (staged.length > 0) return staged;
    const name = recipient.raw.trim();
    return name ? [{ username: name }] : [];
  }

  async function handleAdd() {
    const toAdd = effectiveStaged();
    if (toAdd.length === 0) return;
    const submittedRole = role;
    const askingLanes = needsLaneChoice(submittedRole, targetLanes.length);
    if (askingLanes && !laneChoiceReady(laneChoice, submittedRole, targetLanes.length)) {
      setAddError(t("projectSettings.share.laneChoiceRequired"));
      return;
    }
    const laneAccess = askingLanes && laneChoice ? toMemberLaneAccess(laneChoice) : undefined;
    setAdding(true);
    setAddError(null);
    onAddStart?.();
    let results: MemberAddOutcome[];
    try {
      results = await onAdd(
        toAdd.map((s) => s.username),
        submittedRole,
        laneAccess,
      );
    } catch (e) {
      setAdding(false);
      setAddError(
        onBatchErrorMessage
          ? onBatchErrorMessage(e)
          : "Could not add — please try again.",
      );
      return;
    }
    setAdding(false);
    const succeeded = new Set(
      results.filter((r) => r.ok).map((r) => r.username.toLowerCase()),
    );
    const failures = results.filter((r) => !r.ok);
    // Keep only the people who failed staged so they can be corrected/retried;
    // drop everyone who landed. Also clear the leftover search text.
    const landed = toAdd.filter((s) => succeeded.has(s.username.toLowerCase()));
    setStaged(toAdd.filter((s) => !succeeded.has(s.username.toLowerCase())));
    setRecipient({ mode: "username", raw: "" });
    if (grantScope && landed.length > 0) {
      toast.add({
        type: "success",
        title: describeGrant(t, {
          names: landed.map((s) => s.username),
          roleLevel: submittedRole,
          scope: liveGrantScope(grantScope, targetLanes, submittedRole, laneChoice),
          locale,
        }).sentence,
      });
    }
    if (failures.length > 0) {
      setAddError(formatFailures(failures));
    } else {
      setRole(defaultRole);
    }
  }

  const stagedUsernames = new Set(staged.map((s) => s.username.toLowerCase()));
  const canAdd = staged.length > 0 || recipient.raw.trim().length > 0;
  const shownScope = grantScope
    ? liveGrantScope(grantScope, targetLanes, role, laneChoice)
    : undefined;
  const lanesChosen = laneChoiceReady(laneChoice, role, targetLanes.length);
  const grantCopy = shownScope
    ? describeGrant(t, {
        names: effectiveStaged().map((s) => s.username),
        roleLevel: role,
        scope: shownScope,
        locale,
      })
    : null;

  return (
    <div className="space-y-2">
      {staged.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("org.memberMultiAddRow.peopleToAddAriaLabel")}>
          {staged.map((s) => (
            <li key={s.username}>
              <span className="inline-flex items-center gap-1 rounded-full border bg-muted/40 py-0.5 ps-2.5 pe-1 text-xs">
                <span className="max-w-[12rem] truncate">{s.username}</span>
                <button
                  type="button"
                  aria-label={t("org.teamDetail.removeAriaLabel", { name: s.username })}
                  onClick={() => removeStaged(s.username)}
                  disabled={adding || disabled}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {grantCopy && <GrantScopeNotice sentence={grantCopy.sentence} />}
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_max-content_max-content] sm:items-start">
        <div className="min-w-0">
          <UsernameTypeahead
            value={recipient}
            onChange={setRecipient}
            disabled={adding || disabled}
            showModeToggle={false}
            placeholder={{ username: "Aquilla username" }}
            excludedUserIds={excludedUserIds}
            scopedSearch={scopedUserSearch}
            suggestions={suggestions}
            emptySuggestionsHint={emptySuggestionsHint}
            multiSelect={{
              stagedUsernames,
              onToggleResult: (u) => toggleStaged({ username: u.username, id: u.id }),
              onStageTyped: stageTyped,
            }}
          />
        </div>
        <RoleSelect
          options={roleOptions}
          value={role}
          onValueChange={setRole}
          disabled={adding || disabled}
          aria-label={t("common.roleLabel")}
        />
        <Button
          size={buttonSize}
          className="sm:whitespace-nowrap"
          onClick={() => void handleAdd()}
          disabled={adding || disabled || !canAdd || !lanesChosen}
        >
          {adding ? "Adding…" : grantCopy ? grantButtonLabel(t, t("common.add"), grantCopy.scopeEcho) : "Add"}
        </Button>
      </div>
      {needsLaneChoice(role, targetLanes.length) && (
        <LaneAccessFields
          lanes={targetLanes}
          value={laneChoice}
          onChange={setLaneChoice}
          disabled={adding || disabled}
        />
      )}
      {role >= ROLE.PROJECT_LEAD && targetLanes.length > 0 && (
        <p className="text-[10px] text-muted-foreground">{t("projectSettings.share.laneChoiceLeadNote")}</p>
      )}
      {addError && <p className="text-xs text-destructive">{addError}</p>}
    </div>
  );
}

/**
 * AQU-734: turn the failed entries of a batch add into a single honest
 * message that names each person who didn't land and why — so a partial
 * success ("2 of 3 added") never reads as an all-or-nothing failure.
 */
function liveGrantScope(
  scope: GrantScope,
  lanes: readonly TargetLaneOption[],
  role: number,
  choice: LaneAccessChoice | null,
): GrantScope {
  if (scope.kind !== "project" || !needsLaneChoice(role, lanes.length)) return scope;
  if (!choice) return { ...scope, lanes: "unknown" };
  if (choice.kind === "all") return { ...scope, lanes: "all" };
  const labels = lanes.filter((lane) => choice.laneIds.includes(lane.id)).map((lane) => lane.label);
  return { ...scope, lanes: labels };
}

function formatFailures(failures: MemberAddOutcome[]): string {
  const parts = failures.map((f) =>
    f.error ? `${f.username} (${f.error})` : f.username,
  );
  const noun = failures.length === 1 ? "person" : "people";
  return `Couldn't add ${failures.length} ${noun}: ${parts.join(", ")}.`;
}
