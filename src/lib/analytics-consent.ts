import { analyticsAccount } from "./analytics-account"

/** Effective permission, never the appearance of an unconfirmed signup toggle. */
export function isAnalyticsEnabled(): boolean { return analyticsAccount.eligible() }
export function setAnalyticsEnabled(enabled: boolean): Promise<void> { return analyticsAccount.choose(enabled) }
export function onAnalyticsConsentChange(handler: (enabled: boolean) => void): () => void {
  return analyticsAccount.subscribe(() => handler(analyticsAccount.eligible()))
}
