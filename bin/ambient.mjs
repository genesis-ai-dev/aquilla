#!/usr/bin/env node
// Thin launcher so `ambient` works after `pnpm link` without a build step.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const tsx = join(root, "node_modules", ".bin", "tsx")
const result = spawnSync(tsx, [join(root, "src", "ambient", "cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" })
process.exit(result.status ?? 1)
