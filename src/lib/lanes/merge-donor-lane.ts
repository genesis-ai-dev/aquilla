/**
 * AQU-1602: which of the donor's lanes a sibling merge folds.
 *
 * The merge tool folds a legacy "sibling" project into a host project as one
 * additional lane. It used to read the donor's `target_lang = ''` rows and
 * nothing else — the former default lane, by its tag. A donor whose only lane
 * is NOT that lane (a pair project set up through the languages screen, which
 * gives a second lane of the same language its lane id as the tag, AQU-1418)
 * therefore folded nothing at all: no rows matched, so the merge "succeeded"
 * with `merged: 0`, archived the donor, and lost the translations.
 *
 * So the donor lane is chosen, by `lanes.id`, and the choice is explicit:
 *
 *   - a caller that names `donorLaneId` gets that lane, archived or not — the
 *     whole donor is being retired, and refusing a lane the operator named
 *     would strand its content with nowhere to go;
 *   - a caller that names none gets the donor's single active lane. This is
 *     the legacy pair project the tool exists for, and it is the server half
 *     of "pre-filled when it has one";
 *   - a donor with several active lanes is REFUSED rather than guessed. Which
 *     translations become the host's new lane is the operator's call, and the
 *     refusal carries the candidates so they can pick one.
 *
 * Pure, so the rule is testable without a database and reads the same to the
 * sync-worker fold and to any caller that offers the choice.
 */

/** The shape {@link chooseDonorLane} needs of one of the donor's target lanes. */
export interface DonorLaneCandidate {
  id: string
  name: string
  legacyTag: string | null
  archivedAt: string | null
}

export type ChooseDonorLaneRefusal =
  /** `donorLaneId` names no target lane on the donor. */
  | "not_found"
  /** The donor has no target lane to fold (no active one, and none named). */
  | "none"
  /** Several active lanes and no `donorLaneId` — the operator must choose. */
  | "ambiguous"

export type ChooseDonorLaneResult =
  | { ok: true; lane: DonorLaneCandidate }
  | { ok: false; reason: ChooseDonorLaneRefusal; candidates: DonorLaneCandidate[] }

function isActive(lane: DonorLaneCandidate): boolean {
  return lane.archivedAt == null || lane.archivedAt === ""
}

/**
 * Pick the donor lane to fold. `lanes` is the donor's `role = 'target'` rows;
 * the source lane is shared by every lane and is never a fold donor.
 *
 * On a refusal, `candidates` is what the caller should offer: the active lanes
 * when there are any, otherwise every target lane the donor has (so a donor
 * whose lanes are all archived still shows the operator what it holds).
 */
export function chooseDonorLane(input: {
  lanes: readonly DonorLaneCandidate[]
  donorLaneId?: string | null
}): ChooseDonorLaneResult {
  const lanes = input.lanes
  const active = lanes.filter(isActive)
  const candidates = active.length > 0 ? active : [...lanes]

  const named = typeof input.donorLaneId === "string" ? input.donorLaneId.trim() : ""
  if (named) {
    const lane = lanes.find((row) => row.id === named)
    // Named and archived is allowed on purpose — see the module note.
    return lane ? { ok: true, lane } : { ok: false, reason: "not_found", candidates }
  }

  if (active.length === 1) return { ok: true, lane: active[0]! }
  if (active.length === 0) return { ok: false, reason: "none", candidates }
  return { ok: false, reason: "ambiguous", candidates }
}

/** One-line refusal for an API response. The candidates are listed by id. */
export function donorLaneRefusalMessage(
  reason: ChooseDonorLaneRefusal,
  candidates: readonly DonorLaneCandidate[],
): string {
  const ids = candidates.map((lane) => lane.id).join(", ")
  switch (reason) {
    case "not_found":
      return `donorLaneId names no target lane on the donor project${ids ? `; its lanes are: ${ids}` : ""}`
    case "none":
      return "the donor project has no target lane to fold"
    case "ambiguous":
      return `the donor project has several target lanes; pass donorLaneId to choose one of: ${ids}`
  }
}
