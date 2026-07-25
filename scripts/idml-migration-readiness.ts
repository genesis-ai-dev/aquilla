#!/usr/bin/env tsx

import fs from "node:fs"
import path from "node:path"
import { parseCodexNotebook } from "../src/lib/codex-editor/parse-codex"
import type { CodexNotebookFile } from "../src/lib/codex-editor/types"
import { fileIdFor } from "../src/lib/migrate/ids"
import {
  buildIdmlMetadataPatchEvents,
  classifyIdmlPair,
  isIdmlPair,
  type IdmlMigrationReadiness,
} from "../src/lib/migrate/idml"
import type { FilePairInput } from "../src/lib/migrate/map"
import {
  resolveGitlabIdmlOriginal,
  resolveLocalIdmlOriginal,
} from "./lib/idml-migration-artifacts"

interface ReportRow {
  file: string
  fileId?: string
  status: IdmlMigrationReadiness
  attachment?: string
  patchEventCount: number
}

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function listByStem(dir: string, extension: string): Map<string, string> {
  const result = new Map<string, string>()
  if (!fs.existsSync(dir)) return result
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith(extension)) {
      result.set(name.slice(0, -extension.length), path.join(dir, name))
    }
  }
  return result
}

function parse(file: string | undefined): CodexNotebookFile | undefined {
  return file ? parseCodexNotebook(fs.readFileSync(file, "utf8")) : undefined
}

function pairs(projectDir: string): FilePairInput[] {
  const sources = listByStem(path.join(projectDir, ".project", "sourceTexts"), ".source")
  const targets = listByStem(path.join(projectDir, "files", "target"), ".codex")
  return [...new Set([...sources.keys(), ...targets.keys()])]
    .sort()
    .map((stem) => ({
      relPath: stem,
      name: stem,
      source: parse(sources.get(stem)),
      target: parse(targets.get(stem)),
    }))
    .filter((pair) => pair.source || pair.target)
}

function main(): void {
  const projectDir = process.argv[2]?.startsWith("--") ? undefined : process.argv[2]
  if (!projectDir) {
    throw new Error(
      "usage: idml-migration-readiness.ts <codex-project-dir> "
      + "[--gitlab-pointers] [--project-id <id> --project-key <legacy-key> --patch-events <file>]",
    )
  }
  const gitlab = process.argv.includes("--gitlab-pointers")
  const projectId = value("--project-id")
  const projectKey = value("--project-key")
  const patchOutput = value("--patch-events")
  if (patchOutput && (!projectId || !projectKey)) {
    throw new Error("--patch-events requires --project-id and --project-key")
  }

  const rows: ReportRow[] = []
  const patchEvents: unknown[] = []
  for (const pair of pairs(path.resolve(projectDir))) {
    if (!isIdmlPair(pair)) {
      rows.push({ file: pair.name, status: "not-idml", patchEventCount: 0 })
      continue
    }
    const original = gitlab
      ? resolveGitlabIdmlOriginal(projectDir, pair)
      : resolveLocalIdmlOriginal(projectDir, pair)
    const status = classifyIdmlPair(pair, Boolean(original))
    const fileId = projectKey ? fileIdFor(projectKey, pair.relPath) : undefined
    const patches = projectId && fileId && status === "native-ready"
      ? buildIdmlMetadataPatchEvents(pair, {
          projectId,
          fileId,
          author: "legacy-import",
          // Deterministic CLI output: patch ids and timestamps do not drift.
          clientTs: 0,
        }).events
      : []
    patchEvents.push(...patches)
    rows.push({
      file: pair.name,
      ...(fileId ? { fileId } : {}),
      status,
      ...(original ? { attachment: original.relativePath } : {}),
      patchEventCount: patches.length,
    })
  }

  const counts = Object.fromEntries([
    "native-ready",
    "needs-artifact",
    "ambiguous-locator",
    "unsupported-legacy-html",
    "not-idml",
  ].map((status) => [status, rows.filter((row) => row.status === status).length]))
  const report = { version: 1, projectDir: path.resolve(projectDir), mode: gitlab ? "gitlab-lfs" : "local", counts, files: rows }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (patchOutput) {
    fs.writeFileSync(path.resolve(patchOutput), `${JSON.stringify(patchEvents, null, 2)}\n`)
  }
}

main()
