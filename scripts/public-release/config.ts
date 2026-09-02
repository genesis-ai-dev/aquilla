// Public-release scrub policy — the single source of truth for what the
// orphan-sync pipeline strips, rewrites, generates, and forbids when it
// mirrors this private repo to the public open-source repo.
//
// This file (and everything else under scripts/public-release/) is EXCLUDED
// from the public tree — see EXCLUDE_PATHS — so it is safe (and necessary) to
// name real identifiers here as scrub targets. None of these are new secrets;
// they already live in the tracked private tree. The pipeline's job is to make
// sure they never reach the public mirror.
//
// Design invariant: the public tree is built from `git archive <ref>` (tracked
// files ONLY). Untracked files (.env, .dev.vars, worktree copies) are
// structurally incapable of entering the tree. Everything below is defense in
// depth on top of that guarantee.

/** Paths removed wholesale from the public tree (globs, matched against the
 *  archived tree root). Deleting these is the first scrub pass. */
export const EXCLUDE_PATHS: string[] = [
  // ── The release tooling itself (names real identifiers) ──────────────────
  "scripts/public-release/**",

  // ── Internal engineering planning artifacts ─────────────────────────────
  //   Plans/specs/recon full of partner names, media properties, infra hosts,
  //   and strategy. Not user-facing docs — excluded wholesale.
  "docs/superpowers/**",

  // ── Tier 1: production/customer data & pointers ─────────────────────────
  "db/seed/manifest.json", // real customer project names + UUIDs
  "db/seed/seed.meta.json", // prod account id, R2 bucket, snapshot key, counts

  // ── Tier 1: third-party copyrighted media ───────────────────────────────
  "public/kokoro-previews/**", // TTS of copyrighted Bible translations

  // ── Tier 3: partner trademark asset (orphaned in the tree) ──────────────
  "public/biblica-logo.svg",
  // ── Partner integration module (behind the partner-integrations seam) ───
  //   The whole Biblica module drops out; index.ts is regenerated empty (see
  //   GENERATED_FILES) so the dialog degrades to its built-in sources.
  "src/lib/partner-integrations/biblica/**",
  // Biblica tests that live outside the module (import its fixtures/exports)
  "src/lib/import.biblica.test.ts",
  "src/lib/import.reach4life.test.ts",
  "src/lib/import.treasure-hunt.test.ts",
  "src/lib/export/exporters/idml.rejoin.test.ts",
  "src/lib/export/exporters/idml.reach4life.test.ts",
  "src/lib/export/exporters/idml.treasure-hunt.test.ts",
  "e2e/specs/editor/import-biblica-study-notes.spec.ts",
  "e2e/specs/editor/import-reach4life.spec.ts",
  "e2e/specs/editor/import-treasure-hunt-bible.spec.ts",

  // ── One-off importer referencing a minority-language community dataset ──
  "scripts/import-blackfoot-john.ts",

  // ── Tier 3: other product brands (kept: aquilla; added: acme example) ───
  "src/branding/brands/codex.data.ts",
  "src/branding/brands/codex.tsx",
  "src/branding/brands/honeycomb.data.ts",
  "src/branding/brands/honeycomb.tsx",
  "src/branding/brands/context.data.ts",
  "src/branding/brands/context.tsx",
  "src/branding/assets/codex/**",
  "src/branding/assets/honeycomb/**",
  "src/branding/assets/context/**",
  "public/favicon-codex.svg",
  "public/favicon-honeycomb.svg",
  "public/favicon-context.svg",

  // ── Real Modal model-wrapper code (derived from upstream models) ────────
  //   Replaced by generic stubs in GENERATED_FILES.
  "infra/modal/seed_vc.py",
  "infra/modal/omnivoice_app.py",
  "infra/modal/diarization.py",
]

/** Literal / regex replacements applied to every remaining text file.
 *  `find` may be a string (global replace) or RegExp. Sensitive-but-not-secret
 *  infrastructure identifiers get genericized so forks don't point at Frontier
 *  infra. */
export const STRING_REPLACEMENTS: Array<{ find: string | RegExp; replace: string; note: string }> = [
  // Cloudflare account id (pervasive across the four wrangler.toml files)
  { find: /6a80496d1e59948a9cbaa3c643ba81d7/g, replace: "YOUR_CLOUDFLARE_ACCOUNT_ID", note: "CF account id" },
  // Hyperdrive config ids
  { find: /69bcc10e67464f2eaf4fe91a9141e7cd/g, replace: "YOUR_HYPERDRIVE_ID", note: "hyperdrive prod" },
  { find: /53581197ff7a4202a5ed0ef08537d4a6/g, replace: "YOUR_HYPERDRIVE_DEV_ID", note: "hyperdrive dev" },
  // PostHog client-capture project key (public by design, but genericize so
  // forks don't send events to Frontier's project)
  { find: /phc_oTksJRNEdLEaLD4wmdd2XcR4xaR4n52eA5VGDytW55Ln/g, replace: "YOUR_POSTHOG_PROJECT_KEY", note: "posthog key" },
  // Admin allowlist + contact emails (grant real admin-console access)
  { find: /ryderwishart@gmail\.com/g, replace: "admin@example.com", note: "admin email" },
  { find: /danieljlosey@gmail\.com/g, replace: "admin@example.com", note: "admin email" },
  { find: /the\.disciplexiii@gmail\.com/g, replace: "admin@example.com", note: "admin email" },
  { find: /joel@frontierrnd\.com/g, replace: "contact@example.com", note: "contact email" },
  { find: /jade@frontierrnd\.com/g, replace: "admin@example.com", note: "admin email" },
  // Internal hostnames
  { find: /gitlab\.frontierrnd\.com/g, replace: "git.example.com", note: "internal git host" },
  { find: /git\.genesisrnd\.com/g, replace: "git.example.com", note: "internal git host" },
  // Modal workspace endpoint (match the placeholder style already used in tests)
  { find: /genesis-ai-dev--aquilla-diarization-start\.modal\.run/g, replace: "acct--diarization-web.modal.run", note: "modal endpoint" },
  // Real customer / media-property names used as test + doc fixtures
  { find: /Come and See/g, replace: "Example Org", note: "customer/media fixture name" },
  { find: /The Chosen/g, replace: "Example Series", note: "media property fixture name" },
  // Real seed project slugs used as fixtures
  { find: /bestalu-bible/g, replace: "example-project", note: "real project slug" },
  { find: /suvvali-bible/g, replace: "example-project-2", note: "real project slug" },
  { find: /tamil-alignment/g, replace: "example-alignment", note: "real project slug" },
  { find: /nagamese-pilgrims-progress/g, replace: "example-book", note: "real project slug" },
  { find: /hindi-pilgrims-progress/g, replace: "example-book-2", note: "real project slug" },
  // Partner terms in shared files the module doesn't own (i18n catalogs, a test
  // fixture, docs). Safe to genericize in the public tree now that the whole
  // Biblica module + feature is excluded — these are orphaned/unused there.
  { find: /Biblica(?!l)/g, replace: "Partner", note: "partner name (i18n/tests/docs)" },
  { find: /Reach4Life/g, replace: "PartnerEd", note: "partner product name" },
  { find: /reach4life/g, replace: "partnered", note: "partner product key" },
  { find: /Reach 4 Life/g, replace: "Partner Edition", note: "partner product name" },
  { find: /privacy@frontierrnd\.com/g, replace: "privacy@example.com", note: "privacy contact email" },
  // NOTE: no blanket "biblica" rewrite here — that would inconsistently mangle
  // the deferred-but-functional Biblica feature. Biblica is handled wholesale by
  // the seam refactor (see README "Pending: Biblica"); until then the FORBIDDEN
  // "Biblica" gate blocks publish.
]

/** Files written wholesale into the public tree (generated or copied from
 *  templates/). These replace stripped-and-coupled content with clean,
 *  drift-resistant equivalents. Paths are relative to the tree root. */
export const GENERATED_FILES: Array<{ path: string; from: "template" | "generator"; source: string; note: string }> = [
  // AGPL-3.0 + attribution
  { path: "LICENSE", from: "template", source: "templates/LICENSE", note: "AGPL-3.0" },
  { path: "NOTICE.md", from: "template", source: "templates/NOTICE.md", note: "third-party attribution" },
  // Branding registry regenerated to aquilla + acme only (drift-resistant:
  // always emits a known-good registry regardless of what brands main adds).
  // types.ts is NOT regenerated — the BrandId union is narrowed by codemod so
  // the ThemeTokens/BrandData/Brand shapes stay exactly as main defines them.
  // Empty partner-integrations registry (the biblica module is excluded)
  { path: "src/lib/partner-integrations/index.ts", from: "generator", source: "partnerRegistry", note: "empty partner registry" },
  { path: "src/branding/brands/index.ts", from: "generator", source: "brandIndex", note: "BRANDS registry" },
  { path: "src/branding/brands/data.ts", from: "generator", source: "brandData", note: "BRAND_DATA registry" },
  { path: "src/branding/brands/acme.data.ts", from: "template", source: "templates/acme.data.ts", note: "example brand" },
  { path: "src/branding/brands/acme.tsx", from: "template", source: "templates/acme.tsx", note: "example brand" },
  { path: "src/branding/assets/acme/Mark.tsx", from: "template", source: "templates/acme-Mark.tsx", note: "example brand mark" },
  { path: "src/branding/assets/acme/Wordmark.tsx", from: "template", source: "templates/acme-Wordmark.tsx", note: "example brand wordmark" },
  { path: "public/favicon-acme.svg", from: "template", source: "templates/favicon-acme.svg", note: "example brand favicon" },
  // Generic Modal stubs (no gated-model / upstream-derived code)
  { path: "infra/modal/seed_vc.py", from: "template", source: "templates/modal_seed_vc.py", note: "generic voice-convert stub" },
  { path: "infra/modal/omnivoice_app.py", from: "template", source: "templates/modal_omnivoice.py", note: "generic TTS stub" },
  { path: "infra/modal/diarization.py", from: "template", source: "templates/modal_diarization.py", note: "generic diarization stub" },
  // Example seed files (synthetic Acme data) so structure is documented and
  // seed-extract/seed-fetch references resolve
  { path: "db/seed/manifest.json", from: "template", source: "templates/seed-manifest.example.json", note: "synthetic seed manifest" },
  { path: "db/seed/seed.meta.json", from: "template", source: "templates/seed-meta.example.json", note: "synthetic seed meta" },
]

/** Named codemods run after excludes/replacements. Each is a function keyed by
 *  name in codemods.ts. The one brittle spot: removing the Biblica import
 *  screen from the large, frequently-changing ImportDialog.tsx. */
export const CODEMODS: string[] = [
  "narrowBrandIdUnion", // src/branding/types.ts: BrandId union → "aquilla" | "acme"
  // "removeBiblicaImportScreen" — deferred: needs the partner-integrations seam
  // (see EXCLUDE_PATHS note + README "Pending: Biblica"). Not a safe blind codemod.
]

/** SAFETY GATE. After the tree is built, verify-public-tree.ts asserts ZERO
 *  matches for each pattern and ZERO existence for each path. Any hit aborts
 *  the publish. This is the last line of defense. */
export const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Secret shapes (should never be in tracked files, but assert anyway)
  { pattern: /phc_[A-Za-z0-9]{40,}/, label: "PostHog key" },
  { pattern: /sk-or-v1-[A-Za-z0-9]{20,}/, label: "OpenRouter key" },
  { pattern: /npg_[A-Za-z0-9]{8,}/, label: "Neon password" },
  { pattern: /hf_[A-Za-z0-9]{20,}/, label: "HuggingFace token" },
  { pattern: /cf(at|ut)_[A-Za-z0-9]{20,}/, label: "Cloudflare token" },
  { pattern: /\bak-[A-Za-z0-9]{16,}\b/, label: "Modal token id" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "private key" },
  // Genericized infra identifiers (must all be replaced)
  { pattern: /6a80496d1e59948a9cbaa3c643ba81d7/, label: "CF account id" },
  { pattern: /69bcc10e67464f2eaf4fe91a9141e7cd/, label: "hyperdrive prod id" },
  // Internal orgs / hosts / people. The bare public domain api.frontierrnd.com
  // is fine (it ships in the SPA and forks override it via env); only personal
  // @frontierrnd.com emails and the internal git hosts are sensitive.
  { pattern: /@frontierrnd\.com/, label: "frontierrnd email" },
  { pattern: /genesisrnd\.com/, label: "genesisrnd host" },
  { pattern: /ryderwishart@gmail\.com/, label: "personal admin email" },
  // Partner / proprietary / media properties. `Biblica(?!l)` catches Biblica /
  // BiblicaPanel / importBiblicaStudyNotes without flagging "Biblical".
  { pattern: /Biblica(?!l)/, label: "Biblica (partner)" },
  { pattern: /reach4life/i, label: "Reach4Life (partner product)" },
  { pattern: /\bNIrV\b/, label: "NIrV (copyrighted edition)" },
  { pattern: /The Chosen/, label: "The Chosen (media property)" },
  { pattern: /Come and See/, label: "Come and See (media property)" },
  // Real seed project slugs
  { pattern: /bestalu-bible|suvvali-bible|tamil-alignment|nagamese-pilgrims/, label: "real project slug" },
]

/** Files where specific FORBIDDEN_PATTERNS labels are expected and allowed —
 *  synthetic test vectors for the repo's own secret scanner / auth tests. The
 *  gate skips ONLY the named labels in these files; everything else stays
 *  strict. */
export const ALLOWLIST: Array<{ file: string; labels: string[] }> = [
  {
    file: "scripts/secret-scan.test.ts",
    labels: ["PostHog key", "OpenRouter key", "Neon password", "HuggingFace token", "Cloudflare token", "Modal token id", "private key"],
  },
  { file: "auth-worker/src/__tests__/agent-memory-writes.test.ts", labels: ["private key"] },
]

/** Paths that must NOT exist in the built tree (defense in depth vs EXCLUDE). */
export const FORBIDDEN_PATHS: string[] = [
  ".env",
  ".env.backup",
  ".env.local",
  "**/.dev.vars",
  "**/.dev.vars.bak-before-gemma",
  "src/lib/biblica",
  "public/biblica-logo.svg",
  "public/kokoro-previews",
  "src/branding/brands/codex.data.ts",
  "src/branding/brands/honeycomb.data.ts",
  "src/branding/brands/context.data.ts",
  "scripts/public-release",
]
