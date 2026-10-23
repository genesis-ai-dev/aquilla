#!/usr/bin/env tsx
// AQU-2115 — make EVERY production project's audio play on dev.aquilla.app,
// as a step of the nightly "Refresh Dev Neon Branch" workflow.
//
// AQU-2114 copies one project you name. This asks the restored dev database
// which projects reference media at all, orders them newest-activity-first, and
// runs that same copy across them under a concurrency limit and a wall-clock
// budget. The first backfill is bigger than one night (~561k objects / 167 GB),
// so a run copies what it can and stops at a project boundary; the next run
// resumes without a cursor, because an object already in dev is never copied
// twice.
//
//   pnpm neon:copy-dev-audio-all:dev -- --dry-run
//   pnpm neon:copy-dev-audio-all:dev -- --budget-minutes 240 --concurrency 4
//
// Runs under neon-target, so the branch it reads is explicit and recorded in
// AQUILLA_NEON_TARGET; production, or no target at all, is refused by
// AQU-2114's `copyRefusal` before the first read. Credentials are AQU-2113's
// dedicated copy key (R2_DEV_MEDIA_COPY_ACCESS_KEY_ID /
// R2_DEV_MEDIA_COPY_SECRET_ACCESS_KEY, with R2_ACCOUNT_ID naming the account
// both buckets live in), which carries read on `aquilla-snapshots` and write on
// `aquilla-snapshots-dev` and nothing else.
//
// The decisions — the project set, the order, the budget, the summary — live in
// `scripts/dev-audio-copy-all.ts` and are unit-tested there. This file is the
// I/O, and deliberately mirrors `scripts/neon-copy-dev-audio.ts` so the two
// entry points cannot drift apart.
//
// Flags: --dry-run  --concurrency <n>  --budget-minutes <n>  --limit <n>
import fs from "node:fs"
import process from "node:process"
import { R2Client } from "../src/lib/migrate/r2-s3"
import { loadAudioRefs, loadVoiceRefs } from "../db/shared/media-refs"
import { makeMaintenancePostgres } from "../db/shim/postgres"
import {
  copyProjectAudio,
  formatCopyReport,
  DEV_MEDIA_BUCKET,
  PROD_MEDIA_BUCKET,
  type ListedObject,
} from "./dev-audio-copy"
import {
  copyAllProjectAudio,
  formatCopyAllReport,
  loadAudioProjects,
  numberFlag,
  DEFAULT_BUDGET_MINUTES,
  DEFAULT_COPY_CONCURRENCY,
} from "./dev-audio-copy-all"

function connectionString(): string {
  const direct = process.env.AQUILLA_DATABASE_URL?.trim()
  if (direct) return direct
  const host = process.env.NEON_PG_HOST?.trim()
  const database = process.env.NEON_PG_DB?.trim() || "neondb"
  const role = process.env.NEON_PG_ROLE?.trim() || "neondb_owner"
  const password = process.env.NEON_PG_PASSWORD
  if (!host || !password) throw new Error("NEON_PG_HOST and NEON_PG_PASSWORD are required")
  const url = new URL("postgresql://placeholder")
  url.username = role
  url.password = password
  url.hostname = host
  url.pathname = `/${database}`
  url.searchParams.set("sslmode", "require")
  return url.toString()
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required — see AQU-2113 for the dev media copy key`)
  return value
}

/** Drain every page of a bucket prefix. */
async function listAll(client: R2Client, bucket: string, prefix: string): Promise<ListedObject[]> {
  const out: ListedObject[] = []
  let continuationToken: string | undefined
  do {
    const page = await client.listObjects(bucket, { prefix, continuationToken })
    out.push(...page.objects)
    continuationToken = page.nextToken
  } while (continuationToken)
  return out
}

/** The summary goes on the run page, not only into a step log nobody opens. */
function publishSummary(markdown: string): void {
  console.log(markdown)
  const path = process.env.GITHUB_STEP_SUMMARY
  if (!path) return
  try {
    fs.appendFileSync(path, `${markdown}\n`)
  } catch (error) {
    // A summary we could not write must not fail a copy that worked.
    console.log(
      `::warning title=Dev audio copy summary not written::${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run")
  const concurrency = numberFlag(process.argv, "--concurrency", DEFAULT_COPY_CONCURRENCY)
  const budgetMinutes = numberFlag(process.argv, "--budget-minutes", DEFAULT_BUDGET_MINUTES)
  const limit = process.argv.includes("--limit")
    ? numberFlag(process.argv, "--limit", 0)
    : undefined
  const verbose = process.argv.includes("--verbose")

  const client = new R2Client({
    accountId: requiredEnv("R2_ACCOUNT_ID"),
    accessKeyId: requiredEnv("R2_DEV_MEDIA_COPY_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("R2_DEV_MEDIA_COPY_SECRET_ACCESS_KEY"),
  })
  // One connection per copied project at most, plus the project listing.
  const db = makeMaintenancePostgres(connectionString(), concurrency + 1)
  try {
    const report = await copyAllProjectAudio(
      {
        listProjects: () => loadAudioProjects(db),
        copyOne: async (projectId) => {
          const one = await copyProjectAudio(
            {
              listObjects: (bucket, prefix) => listAll(client, bucket, prefix),
              copyObject: (sourceBucket, sourceKey, destBucket, destKey) =>
                client.copyObject(sourceBucket, sourceKey, destBucket, destKey),
              // The nightly cleanup's own queries (db/shared/media-refs.ts), so
              // what dev copies and what dev keeps cannot disagree.
              loadRefs: async (id) => ({
                audio: await loadAudioRefs(db, id),
                voice: await loadVoiceRefs(db, id),
              }),
            },
            {
              projectId,
              target: process.env.AQUILLA_NEON_TARGET,
              dryRun,
              source: PROD_MEDIA_BUCKET,
              destination: DEV_MEDIA_BUCKET,
            },
          )
          if (verbose) console.log(formatCopyReport(one))
          return one
        },
        now: () => Date.now(),
      },
      { dryRun, concurrency, budgetMs: budgetMinutes * 60_000, limit },
    )
    publishSummary(formatCopyAllReport(report))
    if (dryRun) console.log("dry run — nothing written")
    // A failure anywhere turns THIS step red. The restore step ran before it
    // and stays green, which is the point of giving the copy its own step.
    if (report.projectsFailed.length || report.failedObjects) process.exitCode = 1
  } finally {
    await db.close?.()
  }
}

if (process.argv[1]?.endsWith("neon-copy-dev-audio-all.ts")) {
  main().catch((error) => {
    // A crash before the first copy has no counts to summarise, so the run page
    // would otherwise show a red step and no reason. Annotate, for the same
    // reason the missing-secret path warns rather than logging (AQU-1344).
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(`::error title=Dev audio copy failed::${message.split("\n")[0]}`)
    }
    process.exit(1)
  })
}
