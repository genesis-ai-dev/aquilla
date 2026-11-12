// Entitlement layer for TM governance (Matecat-parity run, C8).
//
// Paid-feature seam for TM governance. Field Plan billing (word allowance)
// lives in auth-worker org_billing; this stub still grants TM opt-out to
// every org until that feature is wired to a plan.
//
// Storage conventions:
//   - the org's plan (AQU-2059) comes from GET /api/v2/orgs/:id/plan; the
//     server's resolveOrgPlan (db/shared/org-plan.ts) is the only copy of the rules
//   - project_settings.settings.contributeToGlobalTm: false → project opts out
//     of the global translation memory (default TRUE when absent).

export const PAID_FEATURES = {
  /** Per-project "do not contribute to global TM" toggle. */
  globalTmOptOut: "global-tm-opt-out",
} as const

export type PaidFeature = (typeof PAID_FEATURES)[keyof typeof PAID_FEATURES]

export interface BillingStub {
  hasPaidFeature(orgId: string, feature: PaidFeature): boolean
}

/** Default stub: every paid feature granted (billing integration pending). */
export const grantAllBillingStub: BillingStub = {
  hasPaidFeature: () => true,
}

export interface OrgSettingsBlob {
  [key: string]: unknown
}

/** The plan as GET /api/v2/orgs/:id/plan returns it. */
export interface OrgPlanSummary {
  tier: "free" | "team" | "enterprise"
}

export interface ProjectSettingsBlob {
  contributeToGlobalTm?: boolean
  [key: string]: unknown
}

export interface ProjectEntitlements {
  /** Effective flag: false ONLY when the project opted out AND the org holds
   *  the paid feature. Default (absent setting) is TRUE per C8. */
  contributeToGlobalTm: boolean
  /** Whether the org may flip the opt-out toggle at all (paid feature). */
  canConfigureTmOptOut: boolean
}

export function resolveProjectEntitlements(args: {
  orgId: string
  orgSettings: OrgSettingsBlob | null | undefined
  projectSettings: ProjectSettingsBlob | null | undefined
  billing?: BillingStub
}): ProjectEntitlements {
  const billing = args.billing ?? grantAllBillingStub
  const canConfigureTmOptOut = billing.hasPaidFeature(args.orgId, PAID_FEATURES.globalTmOptOut)
  const wantsOptOut = args.projectSettings?.contributeToGlobalTm === false
  return {
    contributeToGlobalTm: !(wantsOptOut && canConfigureTmOptOut),
    canConfigureTmOptOut,
  }
}

/** AQU-2059: Enterprise is the org's plan tier, not a settings-blob flag.
 *  Nothing ever wrote `org_settings.settings.enterprise`. */
export const isEnterpriseOrg = (plan: OrgPlanSummary | null | undefined): boolean =>
  plan?.tier === "enterprise"
