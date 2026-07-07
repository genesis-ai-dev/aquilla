// Entitlement layer for TM governance (Matecat-parity run, C8).
//
// Aquilla has no billing system yet — BillingStub is the seam the real
// billing integration will fill. Until then the stub grants every org the
// paid features, so behavior is maximally respectful of user intent while
// the gating logic (and its tests) are real.
//
// Storage conventions (existing "dumb store" blobs, no migrations needed, C6):
//   - org_settings.settings.enterprise: true        → org is enterprise-flagged
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
  enterprise?: boolean
  [key: string]: unknown
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

/** Enterprise flag lives on the org settings blob. */
export const isEnterpriseOrg = (orgSettings: OrgSettingsBlob | null | undefined): boolean =>
  orgSettings?.enterprise === true
