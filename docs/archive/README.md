# docs/archive — closed exercises, kept for provenance

Nothing in this folder is current truth. Each file is the record of a finished,
dated exercise, preserved so the decisions it drove stay traceable. Do not read
these as instructions, and do not edit them: several are explicitly frozen or
append-only, and the run that owned them is closed.

For what the system does today, start at [`../README.md`](../README.md).

## Matecat parity run (`matecat-parity-2026-07-04`)

A closed, time-boxed exercise that scored Aquilla against Matecat's public
commercial translation surface and hardened the export/round-trip and batch code
paths.

| File | What it is |
| --- | --- |
| [`PARITY_FINAL_REPORT.md`](PARITY_FINAL_REPORT.md) | Final scores against the run's exit criteria. |
| [`ITERATION_LOG.md`](ITERATION_LOG.md) | Append-only per-cycle log (hypothesis → diagnostic → metric delta). |
| [`CHANGES.md`](CHANGES.md) | Everything the run changed, grouped by capability. |
| [`QA_TEST_PLAN.md`](QA_TEST_PLAN.md) | The manual QA script written for a human tester at the end of the run. |

**Two of the run's artefacts are still live and therefore are *not* here** — the
files above refer to them by their old root-level names:

- **`PARITY_MATRIX.yaml`** stays at the **repository root**. It is the frozen
  scorecard and a runtime input: `parity/instruments/parity-score.ts` reads it
  from the repo root for `pnpm parity:score`, and the suites under
  `parity/acceptance/` are written against its rows. Moving it breaks the score.
- **`BATCH_ENDPOINT_CONTRACT.md`** now lives at
  [`../BATCH_ENDPOINT_CONTRACT.md`](../BATCH_ENDPOINT_CONTRACT.md). It is the
  frozen normative contract that live code (`src/lib/batch/*`) and
  `parity/batch/contract.test.ts` are still written against, so it is current
  reference material, not history.
