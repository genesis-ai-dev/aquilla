# Generic homepage + unlisted Bible-translation landing page

Date: 2026-07-07
Status: approved for implementation

## Context

The current marketing homepage (`src/pages/Homepage/Homepage.tsx`, served at `/`
and `/homepage`) is written entirely around Bible/ministry translation:
Scripture framing in the hero, John 3:16 as the interactive demo, a "mission
not margin" pricing pitch, and footer copy referencing the All-Access Goals.

Isabella (stakeholder) asked for an unlisted, direct-link-only page focused on
the Bible-translation (BT) audience, to be shared in newsletters/conferences/
meetings rather than surfaced on the public site. Ryder agreed. Separately, the
public homepage needs to drop Bible-specific content so it reads as a general
multimodal translation product.

## Goals

1. Move the current Bible-oriented homepage content to an unlisted route:
   direct-link only, not linked from any nav/footer/sitemap, `noindex` both via
   meta tag and `robots.txt`.
2. Replace the public `/` and `/homepage` content with a Bible-free rewrite of
   the same visual shell — general translation positioning, no Scripture/
   Bible/ministry/church language, no unverifiable claims.
3. Ship without breaking the existing signed-in/signed-out routing behavior at
   `/` (Worker-level redirect to the SPA vs. the static homepage stays as-is).

## Non-goals

- No changes to pricing infrastructure/billing — the $45/project/mo tier is
  marketing-copy-only ("coming soon"), not wired to any payment flow.
- No changes to onboarding, auth, or the SPA routes beyond the new static
  mapping described below.
- No redesign of the visual shell/CSS — this is a content and routing change,
  not a restyle.

## Architecture

Two prebuilt static entry points already exist for the public homepage
(`src/homepage-main.tsx` → `dist/homepage.html`, served by the Worker at `/`
for signed-out visitors and always at `/homepage`). We add a third, parallel
entry point for the BT page, following the same pattern:

- `src/pages/Homepage/Homepage.tsx` — copied verbatim (no content changes) to
  `src/pages/Homepage/BibleTranslationLanding.tsx`. This preserves all current
  Bible-oriented copy exactly.
- `src/pages/Homepage/MultimodalWorkspace.tsx` and
  `src/pages/Homepage/LanguageBlitz.tsx` — copied verbatim to
  `MultimodalWorkspaceBT.tsx` / `LanguageBlitzBT.tsx`, imported only by
  `BibleTranslationLanding.tsx`. `john316.data.ts` is untouched and used only
  by the BT copies. Duplicating these three files (rather than parameterizing
  the originals with props) keeps the BT page's real Bible content completely
  stable while the public homepage's copy and demo data are rewritten
  in place — lower risk than threading content config through shared
  components for a one-time fork.
- New entry point `src/bt-main.tsx`, mirroring `homepage-main.tsx`, mounts
  `BibleTranslationLanding` and builds to `dist/bible-translation.html`. Its
  HTML template includes `<meta name="robots" content="noindex,nofollow">`.
- `worker/index.ts` gets one new static-route mapping:
  `"/bible-translation": "/bible-translation.html"`, alongside the existing
  `/homepage` mapping. No other Worker routing changes — `/` and `/homepage`
  keep serving the (now-generic) `homepage.html` exactly as before.
- `public/robots.txt` (or wherever it's served from) gets
  `Disallow: /bible-translation` as a second, defense-in-depth layer beyond
  the meta tag.
- Nothing in nav, footer, in-app links, or any sitemap references
  `/bible-translation` — it is reachable only if someone is given the URL
  directly.

## Public homepage content rewrite

Editing `Homepage.tsx`, `MultimodalWorkspace.tsx`, `LanguageBlitz.tsx` in
place (the BT copies are unaffected):

- **Hero**: drop the "One workspace for Bible & ministry translation" eyebrow
  and "so Scripture reaches every language" close. New framing: a general
  "one workspace for text, audio, and (soon) video translation" pitch,
  keeping the existing "Translators, lifted." headline (works for any
  translation audience).
- **Trust band**: drop "Come and See · ETEN Innovation Lab · All-Access Goals
  2033" chip row (ETEN and All-Access Goals are Bible-translation-specific
  bodies with no general-market equivalent) — replaced with a generic
  proof-line consistent with the case study kept below.
- **Multimodal manifesto section**: reword "Most of the world meets Scripture
  by listening, not reading" → generic multimodal-access framing. "Oral
  stories" modal tag kept (still true generally) but decoupled from Scripture
  framing.
- **Language-blitz section ("Low-resource? Still in reach")**: reword away
  from "John 3:16 across the world's tongues"; demo mechanism unchanged
  (real corpus-backed multilingual reel), data source swapped (see below).
- **Living Memory / Quality feature demo panels**: replace verse references
  (`Luke 15:13`, `John 3`, `Psalm 96`, `Genesis 1`) with generic
  section/document labels (e.g. `Doc 4.2`, `Section 3.1`) — cosmetic label
  swap only, no logic change.
- **Proof section (Come and See / *The Chosen*)**: kept per stakeholder
  decision, relabeled. Drop the words "Bible"/"Scripture"; keep company name,
  show name, and the verified stats (125 languages, 2× Guinness World
  Record, 240 more in pipeline — unchanged, these don't reference Bible/
  Scripture as words). The pull-quote ("People need to hear the story of
  Jesus in their own language...") is a direct attributed quote from James
  Barnett that is inherently faith-framed — replace it with a stat-focused
  pull-line instead of rewriting someone's words. Eyebrow/heading generalized
  ("Come and See Foundation" eyebrow kept as the named org; headline drops
  no words, it's already generic: "125 languages. A Guinness World Record.
  Twice.").
- **Pricing section**:
  - Heading/subhead: drop "because the mission comes first" / "accelerate
    Bible translation" → generic free-tier framing.
  - Free tier: unchanged mechanically (full workspace, no credit card),
    copy de-churched ("every translator, church, and team" → "every
    translator and team").
  - New middle tier card: "Pro" — usage-based, **$45/project/month**,
    labeled "Coming soon" (disabled CTA or a waitlist link, not a live
    purchase flow), with explicit microcopy that no payment is collected
    today.
  - Enterprise tier: kept, "mission, not margin" chip and "your mission
    matters" language replaced with generic enterprise-support framing;
    "Talk to us" mailto CTA unchanged.
- **Final CTA + footer**: drop "Church and the languages still waiting" and
  "Made for the All-Access Goals — Scripture for every language by 2033" →
  generic multimodal-translation tagline.

## Demo data: UDHR replaces eBible/John 3:16

`john316.data.ts` is Bible-only (BibleNLP/eBible corpus) and stays reserved
for the BT page. The public homepage needs a real, credible, multilingual
corpus with no religious content. The Universal Declaration of Human Rights
(UDHR) is the standard secular substitute: public domain, professionally
translated into 500+ languages, and marketed by the UN itself as "the most
translated document in the world" — a strong, honest proof point.

- New file `src/pages/Homepage/udhr-article1.data.ts`, same shape as
  `VerseEntry` (rename generically, e.g. `SampleEntry`): `code`, `name`,
  `en`, `text`, `dir`, `script`, `domain`.
- Content: UDHR Article 1 text in a curated ~20-30 language set, matching
  the existing script-diversity weighting (Arabic, Devanagari, CJK, RTL,
  etc.), sourced from the Unicode.org UDHR project (unicode.org/udhr) via
  WebFetch during implementation — same "real translation, not AI output"
  claim the current copy makes, just re-pointed at a secular source.
- `LanguageBlitz.tsx` (public-homepage copy) swaps `JOHN_316`/`john316.data`
  import for `UDHR_ARTICLE1`/`udhr-article1.data`; reel/script-detection
  logic is otherwise unchanged.
- Reference sentence in `MultimodalWorkspace.tsx` (public copy) becomes
  *"Every voice deserves to be heard in its own language."* — a neutral line
  that also happens to double as the section's own thesis statement.

## Error handling / edge cases

- If the UDHR data file ends up with fewer usable entries than John 3:16's
  set, that's acceptable — the reel mechanism (`pick()`) already handles any
  `DATA.length`, including small sets.
- Worker static-route mapping follows the exact existing pattern for
  `/homepage`, so no new routing logic/edge cases are introduced.
- No auth/session logic changes — `hasAuthHintCookie()` gating stays exactly
  as-is for `/` and `/homepage`; `/bible-translation` is a fully static,
  unauthenticated page like `/homepage` is today.

## Testing

- Existing Homepage-related unit tests (if any) that assert specific
  Bible-oriented copy strings need updating to match new generic copy, or
  moving to cover `BibleTranslationLanding.tsx` instead if they're meant to
  test the preserved content.
- Manual verification via the dev preview: confirm `/`, `/homepage`, and
  `/bible-translation` all render, confirm the BT page's `<meta
  name="robots">` tag and `robots.txt` entry, confirm no nav/footer link
  reaches `/bible-translation`.
- `pnpm build` must produce all three HTML entry points
  (`index.html`/`homepage.html`/`bible-translation.html`) without errors.
