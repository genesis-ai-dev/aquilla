/**
 * The set of marketing pages that get prerendered at build time.
 *
 * Kept apart from `marketing-pages.tsx` so `scripts/prerender-marketing.ts` can
 * name a page without dragging JSX (and the DOM lib it needs) into the Node
 * tsconfig project.
 */
export const MARKETING_PAGE_IDS = [
  "homepage",
  "bible-translation",
  "beta",
  "case-study",
  "case-study-biblica",
] as const

export type MarketingPageId = (typeof MARKETING_PAGE_IDS)[number]
