#!/usr/bin/env tsx
// AQU-2114 — make one production project's audio play on dev.aquilla.app.
//
// The nightly "Refresh Dev Neon Branch" workflow restores Neon `dev` from
// `production`, which copies every audio ROW but none of the audio BYTES, so a
// migrated project's takes 404 on dev. This copies the bytes the restored rows
// reference — and only those — from `aquilla-snapshots` into
// `aquilla-snapshots-dev`, key for key.
//
//   pnpm neon:copy-dev-audio:dev -- --project <projectId> --dry-run
//   pnpm neon:copy-dev-audio:dev -- --project <projectId>
//
// Runs under neon-target so the branch it reads is explicit and recorded in
// AQUILLA_NEON_TARGET; production, or no target at all, is refused. Credentials
// are the dedicated copy key from AQU-2113:
// R2_DEV_MEDIA_COPY_ACCESS_KEY_ID / R2_DEV_MEDIA_COPY_SECRET_ACCESS_KEY, with
// R2_ACCOUNT_ID naming the account both buckets live in. Where the key carries
// read & write on only those two buckets, CopyObject runs server-side and no
// bytes cross this machine.
//
// The decisions — the copy set, the diff, the two guards — live in
// `scripts/dev-audio-copy.ts` and are unit-tested there. This file is the I/O.
//
// Flags: --project <id>  --dry-run
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

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
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

async function main() {
  const projectId = flagValue("--project")
  if (!projectId) throw new Error("usage: --project <projectId> [--dry-run]")
  const dryRun = process.argv.includes("--dry-run")

  const client = new R2Client({
    accountId: requiredEnv("R2_ACCOUNT_ID"),
    accessKeyId: requiredEnv("R2_DEV_MEDIA_COPY_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("R2_DEV_MEDIA_COPY_SECRET_ACCESS_KEY"),
  })
  // One connection: this reads a handful of reference queries, not a backfill.
  const db = makeMaintenancePostgres(connectionString(), 1)
  try {
    const report = await copyProjectAudio(
      {
        listObjects: (bucket, prefix) => listAll(client, bucket, prefix),
        copyObject: (sourceBucket, sourceKey, destBucket, destKey) =>
          client.copyObject(sourceBucket, sourceKey, destBucket, destKey),
        // The nightly cleanup's own queries (db/shared/media-refs.ts), so what
        // dev copies and what dev keeps cannot disagree.
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
    console.log(formatCopyReport(report))
    if (dryRun) console.log("dry run — nothing written")
    if (report.failed.length) process.exitCode = 1
  } finally {
    await db.close?.()
  }
}

if (process.argv[1]?.endsWith("neon-copy-dev-audio.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
