# 0021 — Translations are filled after the merge, not checked on the pull request

*Decided 2026-11-27 from the CI audit of that day (action 8). AQU-2792. Amends the
enforcement half of AQU-2740; the baseline and its "only shrinks" rule stand.*

## Context

AQU-2740 (merged 2026-11-26) made every pull request carry its own
translations: `pnpm i18n:check` in the `lint` job and
`src/lib/i18n/coverage.test.ts` in `unit` failed a branch whose English had a
string, outside the baseline, that any of 18 locales lacked.

The comparison reads the whole catalog, not the pull request's diff. A pull
request that merged without its translations therefore failed the check on
every other open pull request. In the rule's first 17 hours it failed 21
`lint` jobs, about 16 of them on branches that had not added the strings (an
11-key wave on 4 branches, then a 50-key wave on 8). Nothing requires a green
`ci.yml` run to merge, so this will recur.

It also made translation part of every feature diff. 74 of the last 210
merges to `dev` touched English; each had to change 18 catalogs, the hash
sidecar and the baseline, which is where catalog merge conflicts came from.

## Decision

1. A pull request adds English and its context notes. No pull request check
   reads translation coverage. `pnpm i18n:check` keeps the rules about a
   branch's own English and reports, without failing, how many strings are
   waiting (`scripts/i18n-catalog.ts`).
2. The ratchet is its own command, `pnpm i18n:coverage`, with the comparison
   unchanged (`src/lib/i18n/coverage.ts::coverageViolations`,
   `src/lib/i18n/coverage.ts::unprunedEntries`).
3. `.github/workflows/i18n-fill.yml` translates after the merge. A push to
   `dev` that changes English starts it; a nightly run retries. It runs
   `scripts/i18n-fill.ts`, which writes the packets, has a model translate
   them and imports the answers through the same importer a person uses.
4. A model's answer is imported only if it passes
   `scripts/lib/i18n-fill.ts::leafIssue`: every placeholder kept and none
   invented, and the locale's own script. A string that fails twice stays in
   English and is tried again by the next run.
5. A string the model returns unchanged is recorded in the baseline for that
   locale, because the importer drops a value equal to English
   (`src/lib/i18n/catalog-export.ts::parseTranslatedCatalog`). More than
   `scripts/lib/i18n-fill.ts::keptLimit` of them in one locale is treated as a
   model that did not translate, and none are recorded.
6. The result lands as one pull request the workflow opens and merges itself,
   and only when every file in it passes
   `scripts/release-plan.mjs::isLocaleCatalogOnly`. That is the trust record
   0014 already gives a catalog-only commit.
7. `pnpm i18n:coverage` is the workflow's last step. The job is red while any
   string outside the baseline is still English.

## Consequences

- A release is no longer guaranteed to carry its own strings translated. A
  cut that falls between a merge and its fill ships those strings in English
  until the next release. Cuts start hourly; the fill follows a merge by
  minutes.
- Translation quality is one model's draft per string, with the catalog's
  existing wording in the prompt (`scripts/lib/i18n-fill.ts::priorArt`). It
  was a coding agent's draft before. Neither is a native-speaker review.
- The baseline can now grow without a person: one entry per string a model
  returned unchanged. Each is listed in the fill's pull request.
- If the job is broken, the gap grows silently except for a red workflow run.
  Nothing blocks a merge or a release on it.
- A feature branch that still translates its own strings is not refused. The
  fill then finds nothing to do for them.
- The workflow needs the repository setting that lets GitHub Actions open a
  pull request, and it sends the interface's English strings and context notes
  to the model provider.

## Not covered yet

- A catalog-only pull request is planned like any other pull request: its
  walk reads `unknown`. That holds nothing under the default advisory walk
  policy (`scripts/release-plan.mjs::walkHolds`), and would under `strict`.
- The merge is made with the workflow's own token, so no push-triggered
  workflow runs for it. The workflow starts `dev-deploy.yml` itself; anything
  else that should follow a merge to `dev` does not.
- The backlog the baseline allows (2,000 to 5,500 strings a locale) is not
  filled by this job. `--new` packets hold only what the baseline does not
  allow.
- `i18n-fill.yml` is classified `infra` by
  `scripts/release-risk.mjs::classifyFiles` like any new workflow, until
  someone decides it is off the release line.
