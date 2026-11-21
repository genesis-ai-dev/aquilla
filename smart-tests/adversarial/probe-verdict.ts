import { verifyInvariants, type AdversarialOutcome, type Contract, type Snapshot } from "./invariants"

/* The pure half of probes.ts, kept apart so its tests load no e2e helper. */

/** One request a probe sent, as evidence. Statuses only: never a token or a body. */
export interface Sent { what: string; status: number }

/**
 * The probe's verdict. `hostile` are the requests that must not take effect;
 * `controlLanded` says the same request shape worked for a permitted user.
 * A 5xx to a hostile request is a failure in its own right: a refusal is a
 * 4xx or a rejected event, never a crash.
 */
export function probeOutcome(
  before: Snapshot, after: Snapshot, contract: Contract, hostile: Sent[], controlLanded: boolean,
): AdversarialOutcome {
  const outcome = verifyInvariants(before, after, contract, {
    inputObserved: hostile.length > 0 && controlLanded,
    mutatorApplied: true,
    serverErrors: hostile.filter((request) => request.status >= 500).length,
    pageErrors: 0,
  })
  if (controlLanded || outcome.verdict === "passed") return outcome
  return { ...outcome, reason: `Not attributable to the product: the control request did not land, so the probe's request shape is stale. ${outcome.reason}` }
}
