// Canonical location of the Batch API v1 contract suite, per
// BATCH_ENDPOINT_CONTRACT.md §7. The suite itself lives in
// parity/acceptance/batch-contract.test.ts so parity:score picks up its row
// tags; this file re-runs it from the contract-documented path so a future
// real-endpoint harness can point here. Vitest deduplicates nothing across
// files — the suite executes against a fresh stub either way.
export * from "../acceptance/batch-contract.test"
