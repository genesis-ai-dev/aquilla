# Adversarial Jev suite

Jev attacks the deployed dev build under hostile conditions, hostile goals,
and reworded goals. Independent server reads decide every verdict. Each
verified product failure becomes a Linear Triage ticket under AQU-1330.
The suite is advisory. It never gates a merge or a release.

Design: [the spec](../../docs/superpowers/specs/2026-09-22-jev-adversarial-suite-design.md).
The cooperative suite and the Jev bridge it reuses are described in
[smart testing](../README.md).

## Run it

```sh
pnpm test:smart:setup                                  # pinned Jev, once
pnpm test:adversarial:unit                             # oracle, catalogue, guard, reporter
pnpm test:adversarial --target dev --canary-only       # health gate only, no model
pnpm test:adversarial --target dev                     # every attack, 12 workers
pnpm test:adversarial --target dev --mode redteam
pnpm test:adversarial --target dev --attack edit.reload-mid-type --repeat-each 5
pnpm test:adversarial --target dev --loop              # rerun until stopped
pnpm test:adversarial --target local                   # owned e2e stack four, one worker
pnpm test:adversarial --target preview --branch <branch> --wait-for-sha <sha>
```

Put credentials in the ignored `.env.adversarial.local`, or point
`ADVERSARIAL_ENV_FILE` at another file:

```dotenv
ADVERSARIAL_USER_1=adv-bot:<password>      # the agent
ADVERSARIAL_USER_2=adv-bot-2:<password>    # the second agent in two-user attacks
ADVERSARIAL_USER_3=adv-bot-3:<password>    # owns projects the agent may only view
TYPESAFE_API_KEY=<decision-provider-key>
TYPESAFE_URL=https://openrouter.ai/api/alpha/decisions
TYPESAFE_MODEL=typesafe/jev-1.13
TEXT_MODEL_API_KEY=<text-provider-key>
TEXT_MODEL_BASE_URL=https://openrouter.ai/api/v1
TEXT_MODEL_REASONING=none
TEXT_MODEL=inception/mercury-2.5
LINEAR_API_KEY=<optional; without it findings are printed only>
```

The launcher refuses to start attacks unless both provider URLs are set.
An unset text-provider URL once sent the OpenRouter key to another provider
(PR #716).

The three accounts must be plain accounts on dev. They must **not** be
members of QA Bot Workspace. The PR walk bot's standing projects live
there, and a goal such as "delete every translation" must not be able to
reach them. The local target falls back to the e2e seed users.

## In GitHub Actions

`.github/workflows/adversarial-jev.yml` has two jobs.

- **pr** runs on every non-draft pull request into `dev` from this
  repository. It waits for the commit's Cloudflare preview build check,
  attacks that preview, and keeps one sticky comment on the PR up to
  date. It files no tickets: a PR's findings belong to its author. A
  failed preview build or a preview that never serves the head commit
  gives a **NOT RUN** comment instead of a verdict. Fork and Dependabot
  PRs are skipped because they get no secrets.
- **nightly** attacks deployed dev at 09:00 UTC, or on dispatch, and files
  Linear tickets.

Secrets: `ADVERSARIAL_USER_1..3`, `TYPESAFE_API_KEY`, and
`TEXT_MODEL_API_KEY` as repository secrets. `LINEAR_API_KEY` goes only in
the `adversarial-nightly` environment, restricted to the `dev` branch, so
no PR run can read it. Logs and artifacts are public in this repository;
evidence carries goals, actions, and fixture ids, never tokens.

## How a run works

1. Global setup logs in the three users, creates the org `adv-<run id>`,
   and reads the deployed build from `version.json`. The JWTs go to a
   private temp file, never into `results/` or CI artifacts.
2. **The canary runs first.** A scripted Playwright edit must pass the
   oracle, and a planted wrong-row write must be rejected. No model runs.
   Attacks depend on the canary. If it fails, nothing else runs, no ticket
   is filed, and the rollup reads **HARNESS UNAVAILABLE**.
3. Each attack seeds its own translated three-row project, snapshots it,
   starts Jev on the editor or dashboard, and injects its condition. The
   runner then reads the server again and applies the invariant oracle.
4. A product failure is filed the moment its test ends. An open ticket
   with the same fingerprint gets a comment instead of a duplicate.
5. At the end, one rollup comment goes on AQU-1338. Fixture projects are
   archived, unless a failure occurred. Then they stay for reproduction.

## Verdicts

The oracle compares full snapshots of every project the attack touched:
project names, files, every source and target value, chain heads,
validation flags, comments, and per-cell event history.

| Verdict | Meaning |
| --- | --- |
| `passed` | Every requirement met, nothing outside the allowed changes moved, no 5xx, no page error |
| `product_failure` | Something broke **after** the UI showed the agent's attempt and the condition fired |
| `inconclusive` | The agent never showed the attempt, the condition never fired, or the run did not complete |

Inconclusive is never a pass and never a ticket. Inconclusive fuzz attacks
are listed as navigability misses in the rollup.

A product failure can still be an agent mistake that left the same state as
a product fault, for example an edit on the wrong row. Tickets land in
Triage, and their body says to rule this out before promoting.

## Adding an attack

Add an entry to `ATTACKS` in `attacks.ts`: a goal, the changes it may make,
and what must hold afterward. A new hostile condition also needs a case in
`mutators.ts`. `attacks.test.ts` checks the catalogue's rules.

## Limits

- Parallel attacks share the run org. Goals name their own project, but
  an agent that wanders into another test's project could break that
  test's invariants.
- CDP throttling slows HTTP only. WebSocket frames stay fast.
- `prod-canary` runs only the model-free canary against production,
  with its own accounts. The guard refuses attacks there.
- Jev cannot drag, press shortcuts, or use canvas controls, so those
  surfaces are out of reach.
