import { listProjects } from "@/lib/store/project-index"

export const LEGACY_ONBOARDING_MIGRATION_TIMEOUT_MS = 5_000

export const ONBOARDING_COMPLETE_KEY = "aquilla:onboardingComplete"
export const LOCAL_ONBOARDING_COMPLETE_KEY = `${ONBOARDING_COMPLETE_KEY}:local`
export const PRODUCT_TOUR_ELIGIBLE_KEY = "aquilla:productTourEligible"
const ACCOUNT_PREFIX = `${ONBOARDING_COMPLETE_KEY}:account:`

function accountKey(username: string): string {
  return `${ACCOUNT_PREFIX}${encodeURIComponent(username)}`
}

/** Browser-local completion is exclusively for local-only mode. */
export function isLocalOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(LOCAL_ONBOARDING_COMPLETE_KEY) === "true"
  } catch {
    return false
  }
}

export function hasLegacyOnboardingCompletion(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true"
  } catch {
    return false
  }
}

/** Signed-in onboarding completion belongs to one canonical account. */
export function isAccountOnboardingComplete(username: string): boolean {
  try {
    return localStorage.getItem(accountKey(username)) === "true"
  } catch {
    return false
  }
}

function markTourEligible(): void {
  localStorage.setItem(PRODUCT_TOUR_ELIGIBLE_KEY, "true")
}

export function markLocalOnboardingComplete(): void {
  try {
    localStorage.setItem(LOCAL_ONBOARDING_COMPLETE_KEY, "true")
    markTourEligible()
  } catch {
    // Private-mode / storage-blocked: local project routing still works directly.
  }
}

export function markAccountOnboardingComplete(username: string): void {
  try {
    localStorage.setItem(accountKey(username), "true")
    markTourEligible()
  } catch {
    // Private-mode / storage-blocked: the active session and direct route still work.
  }
}

function removeLegacyCompletion(): void {
  try {
    localStorage.removeItem(ONBOARDING_COMPLETE_KEY)
  } catch {
    // If storage is unreadable there is nothing reliable to migrate.
  }
}

/**
 * One-time migration for the pre-account-scoping completion marker.
 *
 * The old key was written by both signed-account and local-only onboarding,
 * so the value alone cannot identify its owner. A hydrated account is the
 * strongest available authority and receives the marker. Signed-out profiles
 * only keep local completion when IndexedDB contains a genuinely local-shaped
 * project; otherwise the ambiguous marker is retired and login remains the
 * safe entry point. No project data is removed by this migration.
 */
export async function migrateLegacyOnboardingCompletion(
  activeUsername: string | null,
  options: {
    listProjectsFn?: typeof listProjects
    timeoutMs?: number
  } = {},
): Promise<boolean> {
  if (isLocalOnboardingComplete()) return true
  if (!hasLegacyOnboardingCompletion()) return false

  if (activeUsername) {
    markAccountOnboardingComplete(activeUsername)
    removeLegacyCompletion()
    return false
  }

  const projects = await withTimeout(
    (options.listProjectsFn ?? listProjects)({ includeTrashed: true }),
    options.timeoutMs ?? LEGACY_ONBOARDING_MIGRATION_TIMEOUT_MS,
  )
  const hasLocalWorkspace = projects.some((project) => !project.origin && !project.syncRole)

  if (hasLocalWorkspace) markLocalOnboardingComplete()
  removeLegacyCompletion()
  return hasLocalWorkspace
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Onboarding storage did not respond")),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
