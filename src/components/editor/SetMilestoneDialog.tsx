// "Set a new milestone…" — name a start→end range of this file's cells. (AQU-2308)
//
// Three questions and nothing else: a name, a first line, a last line. The
// range is what makes this different from the canceled marker design (AQU-2185,
// which named ONE cell and ran to the next marker, so "lines 50 to 70 are The
// storm" also forced a name on whatever followed line 70).
//
// EVERY REFUSAL COMES FROM `refusalForUserMilestone`, never from a rule
// re-stated here. That function is the same one the navigator derivation
// consults, so the dialog cannot refuse a range the derivation would have
// accepted — or, worse, accept one the derivation would silently skip, leaving
// a maintainer with a saved milestone that never appears.

import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SearchSelect, type SearchSelectOption } from "@/components/ui/search-select"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  milestoneDraftLabel,
  type MilestoneDraftCell,
} from "@/lib/editor/milestone-draft"
import {
  refusalForUserMilestone,
  type UserMilestoneRefusal,
} from "@/lib/editor/user-milestone-spans"
import {
  MILESTONE_NAME_MAX_LENGTH,
  normalizeMilestoneName,
  type FileMilestone,
} from "../../../db/shared/file-milestones"
import type { ImportMilestone } from "../../../shared/import-contract"

export interface MilestoneDraftSubmission {
  name: string
  startCellId: string
  endCellId: string
}

/**
 * MOUNTED PER DRAFT, deliberately. There is no `open` prop: the workspace
 * renders this only while a range is being named, so the pickers and the name
 * come back empty by construction rather than by a reset effect whose
 * dependencies someone has to keep right. (The same shape
 * `SourceEditWarningDialog` uses.)
 */
export interface SetMilestoneDialogProps {
  /** Escape, the overlay, the X, or Cancel. */
  onDismiss: () => void
  /** Picker rows for this file, in its display order. */
  cells: readonly MilestoneDraftCell[]
  /** The division each cell belongs to, aligned with `cells`. */
  divisions: readonly (ImportMilestone | undefined)[]
  /** The file's milestones as stored, so an overlap can be refused BY NAME. */
  existing: readonly FileMilestone[]
  /** Prefilled edges — the clicked row, or a shift-click selection's edges. */
  initialStartCellId: string
  initialEndCellId: string
  onSubmit: (draft: MilestoneDraftSubmission) => void
}

export function SetMilestoneDialog({
  onDismiss,
  cells,
  divisions,
  existing,
  initialStartCellId,
  initialEndCellId,
  onSubmit,
}: SetMilestoneDialogProps) {
  const t = useT()
  const [name, setName] = useState("")
  const [startCellId, setStartCellId] = useState(initialStartCellId)
  const [endCellId, setEndCellId] = useState(initialEndCellId)

  const order = useMemo(() => cells.map((cell) => cell.cellId), [cells])
  const startIndex = order.indexOf(startCellId)

  const startOptions = useMemo<SearchSelectOption[]>(
    () => cells.map(toOption),
    [cells],
  )
  // The end picker does not OFFER a cell before the start — it does not list
  // one disabled. A range that runs backwards is not an action a person is
  // choosing between; it is one they cannot mean.
  const endOptions = useMemo<SearchSelectOption[]>(
    () => (startIndex < 0 ? [] : cells.slice(startIndex).map(toOption)),
    [cells, startIndex],
  )

  const refusal = refusalForUserMilestone(
    order,
    divisions,
    existing,
    { name, startCellId, endCellId },
    normalizeMilestoneName,
  )
  const message = refusalMessage(refusal, t)

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onDismiss() }}>
      <DialogContent data-testid="set-milestone-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("editor.setMilestone.title")}</DialogTitle>
          <DialogDescription>{t("editor.setMilestone.description")}</DialogDescription>
        </DialogHeader>
        <form
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault()
            if (refusal !== null) return
            onSubmit({ name, startCellId, endCellId })
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="set-milestone-name">
                {t("editor.setMilestone.nameLabel")}
              </FieldLabel>
              <Input
                id="set-milestone-name"
                data-testid="set-milestone-name"
                value={name}
                maxLength={MILESTONE_NAME_MAX_LENGTH}
                placeholder={t("editor.setMilestone.namePlaceholder")}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="set-milestone-start">
                {t("editor.setMilestone.startLabel")}
              </FieldLabel>
              <SearchSelect
                id="set-milestone-start"
                data-testid="set-milestone-start"
                options={startOptions}
                value={startCellId}
                searchPlaceholder={t("editor.setMilestone.searchPlaceholder")}
                emptyText={t("editor.setMilestone.noMatches")}
                optionTestId={(option) => `set-milestone-start-${option.value}`}
                onValueChange={(next) => {
                  setStartCellId(next)
                  // Moving the start PAST the end clears the end rather than
                  // dragging it along: which line the range should now finish
                  // on is the person's call, and guessing it would quietly
                  // change a range they already chose.
                  const nextIndex = order.indexOf(next)
                  const currentEnd = order.indexOf(endCellId)
                  if (nextIndex >= 0 && (currentEnd < 0 || currentEnd < nextIndex)) {
                    setEndCellId("")
                  }
                }}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="set-milestone-end">
                {t("editor.setMilestone.endLabel")}
              </FieldLabel>
              <SearchSelect
                id="set-milestone-end"
                data-testid="set-milestone-end"
                options={endOptions}
                value={endCellId}
                placeholder={t("editor.setMilestone.endPlaceholder")}
                searchPlaceholder={t("editor.setMilestone.searchPlaceholder")}
                emptyText={t("editor.setMilestone.noMatches")}
                optionTestId={(option) => `set-milestone-end-${option.value}`}
                onValueChange={setEndCellId}
              />
              {message ? (
                <FieldError data-testid="set-milestone-refusal">{message}</FieldError>
              ) : null}
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onDismiss}>
              {t("common.cancel")}
            </Button>
            <Button
              type="submit"
              data-testid="set-milestone-save"
              disabled={refusal !== null}
            >
              {t("editor.setMilestone.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function toOption(cell: MilestoneDraftCell): SearchSelectOption {
  return {
    value: cell.cellId,
    label: milestoneDraftLabel(cell),
    // So a reference is reachable by typing it even on a file whose rows show
    // their line numbers.
    keywords: cell.reference ?? "",
  }
}

/**
 * What to SAY about a refusal, or null when there is nothing to say.
 *
 * A missing name or a half-picked range is the dialog's opening state, not a
 * mistake, so those only hold the save button — telling someone off for not
 * having typed yet is noise. The two structural refusals always name what they
 * clash with, because "that overlaps something" is not an answer a maintainer
 * can act on.
 */
function refusalMessage(
  refusal: UserMilestoneRefusal | null,
  t: ReturnType<typeof useT>,
): string | null {
  if (refusal === null) return null
  switch (refusal.reason) {
    case "blank-name":
    case "no-range":
      return null
    case "backwards":
      return t("editor.setMilestone.backwards")
    case "crosses-division":
      return t("editor.setMilestone.crossesDivision", { division: refusal.divisionLabel })
    case "overlaps":
      return t("editor.setMilestone.overlaps", { name: refusal.milestoneName })
  }
}
