/**
 * Emergency kill switch for client-side health work: decay health, rule
 * infraction checks, the confidence overlay fetch, and the per-row health
 * ribbon. These are suspected of driving large memory spikes in the editor
 * (whole-file walks that retain per-cell signatures, inputs, and points).
 *
 * Flip `HEALTH_CALCULATIONS_DISABLED` to `false` to restore the feature. For
 * a one-off check on a single browser, `localStorage.setItem("health-calculations", "1")`
 * then reload re-enables the calculations without a rebuild.
 */
const HEALTH_CALCULATIONS_DISABLED = true

function resolve(): boolean {
  if (!HEALTH_CALCULATIONS_DISABLED) return true
  try {
    return localStorage.getItem("health-calculations") === "1"
  } catch {
    return false
  }
}

/** Read once at module load; a reload picks up the localStorage override. */
export const HEALTH_CALCULATIONS_ENABLED = resolve()
