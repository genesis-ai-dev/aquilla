// AQU-1998 §Remove — the "who is on this lane now" half of StaffLanePopover.
//
// Staffing someone onto a lane was one gesture (StaffLanePopover); taking them
// off was a trip to the org Members → Matrix tab, nowhere near the lane. This
// list sits in the same popover and makes the undo a sibling of the do: every
// person currently scoped to the lane, each with Remove.
//
// The last lane is deliberately not removable. An empty lane list means EVERY
// lane, so dropping someone's only lane *widens* their access instead of
// narrowing it — the trap the matrix still falls into when you untick the last
// chip and save. That case keeps Remove disabled and points at Project
// Settings → Team members, where the person can be taken off the project
// outright. What a last-lane removal should actually do is a separate call.
//
// Presentational on purpose: the popover owns the scope reads and the PUT, so
// this file stays about rendering one list and its one guard.

import { Link, useLocation } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { projectSettingsPath } from "@/lib/navigation/org-paths"
import { useI18n } from "@/lib/i18n/I18nProvider"

export interface StaffedLanePerson {
  userId: number
  username: string
  /**
   * How many lanes this member is scoped to in total. `1` means this lane is
   * their only one, which is what the guard refuses — see the file header.
   */
  laneCount: number
}

export interface StaffedLaneMembersProps {
  projectId: string
  /** The lane's display label — named in the Remove control's accessible name. */
  laneLabel: string
  /** `null` while the first scope read for the open popover is still in flight. */
  people: StaffedLanePerson[] | null
  /** The person whose removal is in flight, if any. */
  busyUserId: number | null
  /** A failed removal: the message shows on that person's row, who stays listed. */
  error: { userId: number; message: string } | null
  /** Called when the operator confirms a removal. */
  onRemove: (person: StaffedLanePerson) => void
  /** Closes the popover when the guard's settings link navigates away. */
  onNavigate?: () => void
}

export function StaffedLaneMembers({
  projectId,
  laneLabel,
  people,
  busyUserId,
  error,
  onRemove,
  onNavigate,
}: StaffedLaneMembersProps) {
  const { t } = useI18n()
  const location = useLocation()

  return (
    <div className="space-y-1.5" data-testid="staff-lane-staffed">
      <p className="text-[11px] font-medium text-muted-foreground">
        {t("org.staffLanePopover.staffedHeading")}
      </p>
      {people === null ? (
        <p className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-muted-foreground">
          <Spinner className="size-3" />
          {t("common.loading")}
        </p>
      ) : people.length === 0 ? (
        <p
          data-testid="staff-lane-staffed-empty"
          className="px-2 py-1.5 text-[11px] text-muted-foreground"
        >
          {t("org.staffLanePopover.staffedEmpty")}
        </p>
      ) : (
        <ul className="max-h-40 divide-y overflow-y-auto rounded border">
          {people.map((person) => {
            const lastLane = person.laneCount <= 1
            const busy = busyUserId === person.userId
            return (
              <li
                key={person.userId}
                data-testid={`staff-lane-staffed-row-${person.userId}`}
                className="px-2 py-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <UsernameWithAvatar
                    userId={person.userId}
                    username={person.username}
                    size="xs"
                    nameClassName="text-xs"
                  />
                  <Button
                    variant="ghost"
                    className="h-6 px-1.5 text-[11px]"
                    data-testid={`staff-lane-remove-${person.userId}`}
                    aria-label={t("org.staffLanePopover.removeFromLaneAriaLabel", {
                      name: person.username,
                      lane: laneLabel,
                    })}
                    disabled={lastLane || busy}
                    onClick={() => onRemove(person)}
                  >
                    {busy && <Spinner className="me-1 size-3" />}
                    {t("org.membersPage.remove")}
                  </Button>
                </div>
                {lastLane && (
                  <p
                    data-testid={`staff-lane-last-lane-note-${person.userId}`}
                    className="mt-1 text-[11px] text-muted-foreground"
                  >
                    {t("org.staffLanePopover.lastLaneNote", { name: person.username })}{" "}
                    <Link
                      to={projectSettingsPath(projectId, "members")}
                      state={{ backgroundLocation: location, projectSettingsModalDepth: 1 }}
                      className="font-medium text-foreground underline underline-offset-2"
                      onClick={onNavigate}
                    >
                      {t("org.staffLanePopover.teamMembersLink")}
                    </Link>
                  </p>
                )}
                {error?.userId === person.userId && (
                  <p
                    data-testid={`staff-lane-remove-error-${person.userId}`}
                    className="mt-1 text-[11px] text-destructive"
                  >
                    {error.message}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
