/**
 * AQU-2289: the one dialog behind every "Change role" and every "Add member".
 *
 * Sam, Oct 29 (settings cleanup 4c, option A): keep every door, but each one
 * opens this same dialog with the same list of roles for the same level. The
 * doors are Project settings → Members (also the dashboard's Members card and
 * the onboarding invite step, which render the same pane), the organization
 * roster, the members matrix, and the Team page.
 *
 * The roles always come from `roleChoices()`, capped at what the person
 * choosing may grant; no door passes its own list. Team-scope roles are not
 * set here: they keep their own three in the Team role column.
 *
 * Two modes, one frame:
 *   - `change`: one person (or a team's grant on a project) and a role. With
 *     no current role it adds that one known person, e.g. an empty cell of the
 *     members matrix, and asks for Language lanes when the role needs them.
 *   - `add`: people picked from a search, a role, and Add. Other ways in, such
 *     as an invite link or an email invite, sit in tabs beside it.
 *
 * Text follows the settings rule: one short visible line, the rest behind a
 * click (i) that opens in place.
 */
import { useState, type ReactNode } from "react"
import { AlertTriangle, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { GrantScopeNotice } from "@/components/GrantScopeNotice"
import { LaneAccessFields } from "@/components/LaneAccessFields"
import { MemberMultiAddRow, type MemberMultiAddRowProps } from "@/components/MemberMultiAddRow"
import { RoleSelect, roleSelectOptionFromLevel } from "@/components/RoleSelect"
import type { TargetLaneOption } from "@/hooks/useCurrentTargetLanes"
import { describeGrant, type GrantScope } from "@/lib/access/grant-scope-sentence"
import { toUserFacingError } from "@/lib/errors/user-error"
import { roleChoices, type RoleChoiceLevel } from "@/lib/frontier/role-choices"
import { ROLE } from "@/lib/frontier/roles"
import {
  chosenLaneLabels,
  laneChoiceReady,
  needsLaneChoice,
  toMemberLaneAccess,
  type LaneAccessChoice,
  type MemberLaneAccess,
} from "@/lib/lanes/lane-access-choice"
import { useI18n } from "@/lib/i18n/I18nProvider"

interface RoleDialogBase {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Which list of roles: the organization's or a project's. */
  level: RoleChoiceLevel
  /** The chooser's own role at that level. Caps the list; `null` = unknown. */
  callerLevel: number | null
  /** One short line under the title. */
  summary?: string
  /** The rest of the explanation, behind a click (i). */
  details?: string
}

export interface ChangeRoleDialogProps extends RoleDialogBase {
  mode: "change"
  /** Whose role: a person's username, or a project's name for a team grant. */
  name: string
  /** Their role here now. `null` adds this one person. */
  currentLevel: number | null
  /** Where they're being added, for the title when there is no current role. */
  where?: string
  /** When set, a live sentence says who gets which role where. */
  grantScope?: GrantScope
  /** Adding one person to a project: its Language lanes, for roles that need them. */
  targetLanes?: readonly TargetLaneOption[]
  onSave: (level: number, laneAccess?: MemberLaneAccess) => Promise<void>
  /** The line shown when saving fails. Defaults to the error's own message. */
  errorMessage?: (error: unknown) => string
  /** A second action beside Save, e.g. the matrix's Remove from project. */
  remove?: { label: string; onRemove: () => Promise<void> }
}

export type MemberAddRowConfig = Omit<MemberMultiAddRowProps, "roleOptions">

export interface AddPeopleDialogProps extends Omit<RoleDialogBase, "level"> {
  mode: "add"
  /**
   * Which list of roles the people row offers. `team` has none to pick: a
   * team's new members take its project grants, and their team role (the
   * team's own three) is set afterwards in the Team role column.
   */
  level: RoleChoiceLevel | "team"
  title: string
  /**
   * Who to add. `row` is the shared search + role + Add row, with the role
   * list taken from `roleChoices`. `custom` is for a team, which has no role
   * to pick here.
   */
  people:
    | { kind: "row"; row: MemberAddRowConfig }
    | { kind: "custom"; body: ReactNode; footer?: ReactNode }
  /** Other ways in, as tabs after the people tab. */
  otherTabs?: ReadonlyArray<{ value: string; label: string; content: ReactNode }>
  /** Shown under the people row, e.g. a permission alert. */
  note?: ReactNode
}

export type RoleDialogProps = ChangeRoleDialogProps | AddPeopleDialogProps

const PEOPLE_TAB = "people"

export function RoleDialog(props: RoleDialogProps) {
  const { open, onOpenChange, level, mode } = props
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={mode === "add" ? "max-w-lg" : "max-w-md"}
        data-testid="role-dialog"
        data-role-dialog-mode={mode}
        data-role-level={level}
      >
        {/* Keyed so a reopened dialog starts from the person's current role. */}
        {open && (props.mode === "change"
          ? <ChangeBody key={`${props.name}:${props.currentLevel ?? "none"}`} {...props} />
          : <AddBody {...props} />)}
      </DialogContent>
    </Dialog>
  )
}

function Header({ title, summary, details }: { title: string; summary?: string; details?: string }) {
  const { t } = useI18n()
  const [infoOpen, toggleInfo] = useInfoOpen()
  return (
    <DialogHeader>
      <DialogTitle>{title}</DialogTitle>
      {(summary || details) && (
        <DialogDescription className="flex items-start gap-1">
          <span className="min-w-0">{summary}</span>
          {details && (
            <InfoToggle
              open={infoOpen}
              onToggle={toggleInfo}
              label={t("org.roleDialog.moreAboutRolesAriaLabel")}
              controls="role-dialog-details"
              testId="role-dialog-info"
            />
          )}
        </DialogDescription>
      )}
      {details && (
        <InfoReveal open={infoOpen} id="role-dialog-details" testId="role-dialog-details" className="text-sm text-muted-foreground">
          {details}
        </InfoReveal>
      )}
    </DialogHeader>
  )
}

function ChangeBody({
  onOpenChange,
  level,
  callerLevel,
  summary,
  details,
  name,
  currentLevel,
  where,
  grantScope,
  targetLanes,
  onSave,
  errorMessage,
  remove,
}: ChangeRoleDialogProps) {
  const { t, locale } = useI18n()
  const options = roleChoices(level, { callerLevel, purpose: "change" })
  const adding = currentLevel === null
  const [picked, setPicked] = useState<number | null>(
    currentLevel ?? (options.some((o) => o.level === ROLE.CONTRIBUTOR) ? ROLE.CONTRIBUTOR : options[0]?.level ?? null),
  )
  const [laneChoice, setLaneChoice] = useState<LaneAccessChoice | null>(null)
  const [busy, setBusy] = useState<"save" | "remove" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [warningInfoOpen, toggleWarningInfo] = useInfoOpen()

  const lanes = adding ? targetLanes ?? [] : []
  const asksLanes = picked !== null && needsLaneChoice(picked, lanes.length)
  const lanesReady = picked === null || laneChoiceReady(laneChoice, picked, lanes.length)
  // A role the list does not offer (an organization Commenter left from
  // before, a project Owner) still shows on the closed control.
  const currentOption =
    currentLevel !== null && !options.some((o) => o.level === currentLevel)
      ? roleSelectOptionFromLevel(currentLevel)
      : null
  const promotingToOwner = level === "org" && picked === ROLE.OWNER && currentLevel !== ROLE.OWNER

  const sentence = grantScope && picked !== null
    ? describeGrant(t, {
        names: [name],
        roleLevel: picked,
        scope: grantScope.kind === "project" && asksLanes
          ? {
              ...grantScope,
              lanes: laneChoice ? chosenLaneLabels(lanes, picked, laneChoice) : "unknown",
            }
          : grantScope,
        locale,
      }).sentence
    : null

  async function save() {
    if (picked === null) return
    setBusy("save")
    setError(null)
    try {
      await onSave(picked, asksLanes && laneChoice ? toMemberLaneAccess(laneChoice) : undefined)
      onOpenChange(false)
    } catch (e) {
      setError(errorMessage ? errorMessage(e) : toUserFacingError(e, level === "org" ? "org" : "project").message)
    } finally {
      setBusy(null)
    }
  }

  async function runRemove() {
    if (!remove) return
    setBusy("remove")
    setError(null)
    try {
      await remove.onRemove()
      onOpenChange(false)
    } catch (e) {
      setError(errorMessage ? errorMessage(e) : toUserFacingError(e, "project").message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Header
        title={adding
          ? t("org.roleDialog.addPersonTitle", { name, where: where ?? "" })
          : t("org.teamDetail.changeRoleTitleFor", { name })}
        summary={summary}
        details={details}
      />
      <div className="flex flex-col gap-3">
        {sentence && <GrantScopeNotice sentence={sentence} />}
        <RoleSelect
          options={options}
          currentOption={currentOption}
          value={picked}
          onValueChange={(next) => {
            setError(null)
            setPicked(next)
          }}
          disabled={busy !== null}
          className="w-full!"
          aria-label={t("org.teamDetail.roleForAriaLabel", { name })}
        />
        {asksLanes && picked !== null && (
          <LaneAccessFields
            name={`role-dialog-lanes-${name}`}
            lanes={lanes}
            value={laneChoice}
            onChange={setLaneChoice}
            disabled={busy !== null}
          />
        )}
        {promotingToOwner && (
          <div
            data-testid="role-dialog-owner-warning"
            className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-muted-foreground"
          >
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-px size-4 shrink-0 text-amber-600" aria-hidden />
              <span className="min-w-0 flex-1">{t("org.roleDialog.ownerWarning")}</span>
              <InfoToggle
                open={warningInfoOpen}
                onToggle={toggleWarningInfo}
                label={t("org.roleDialog.ownerWarningMoreAriaLabel")}
                controls="role-dialog-owner-details"
                testId="role-dialog-owner-info"
              />
            </p>
            <InfoReveal open={warningInfoOpen} id="role-dialog-owner-details" className="ps-6">
              {t("org.roleDialog.ownerWarningDetails")}
            </InfoReveal>
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">{error}</p>
        )}
      </div>
      <DialogFooter className="sm:justify-between">
        {remove ? (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => void runRemove()}
            disabled={busy !== null}
          >
            {busy === "remove" ? <Spinner data-icon="inline-start" /> : <Trash2 data-icon="inline-start" />}
            {remove.label}
          </Button>
        ) : <span aria-hidden />}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy !== null}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={picked === null || picked === currentLevel || !lanesReady || busy !== null}
          >
            {busy === "save" && <Spinner data-icon="inline-start" />}
            {adding
              ? busy === "save" ? t("common.adding") : t("common.add")
              : busy === "save" ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}

function AddBody({ level, callerLevel, summary, details, title, people, otherTabs, note }: AddPeopleDialogProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState(PEOPLE_TAB)
  const peopleBody = people.kind === "row"
    ? <MemberMultiAddRow
        {...people.row}
        roleOptions={level === "team" ? [] : roleChoices(level, { callerLevel, purpose: "add" })}
      />
    : people.body
  const peopleTab = (
    <div className="space-y-3">
      {peopleBody}
      {note}
    </div>
  )
  return (
    <>
      <Header title={title} summary={summary} details={details} />
      {otherTabs && otherTabs.length > 0 ? (
        <Tabs value={tab} onValueChange={(v) => setTab((v as string) ?? PEOPLE_TAB)} className="gap-3">
          <TabsList size="lg" className="w-full" aria-label={t("org.membersPage.orgTable.addMethodAriaLabel")}>
            <TabsTrigger value={PEOPLE_TAB}>{t("org.membersPage.orgTable.addMembersTab")}</TabsTrigger>
            {otherTabs.map((o) => (
              <TabsTrigger key={o.value} value={o.value}>{o.label}</TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={PEOPLE_TAB}>{peopleTab}</TabsContent>
          {otherTabs.map((o) => (
            <TabsContent key={o.value} value={o.value}>{o.content}</TabsContent>
          ))}
        </Tabs>
      ) : peopleTab}
      {people.kind === "custom" && people.footer}
    </>
  )
}
