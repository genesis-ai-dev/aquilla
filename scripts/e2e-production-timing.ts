// Entrypoint for the AQU-1024 production timing probe.
//
// Unlike scripts/e2e-up.ts this boots nothing: the target is a deployed
// environment. The script's job is to fail fast, and legibly, when the probe
// has not been pointed at one — a missing credential should not surface as a
// Playwright collection error.
//
//   AQUILLA_PROD_USERNAME=… AQUILLA_PROD_PASSWORD=… AQUILLA_PROD_PROJECT_ID=… \
//     pnpm test:e2e:production:timing
//
// Extra arguments are forwarded to `playwright test`.

import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  describeProductionTimingTarget,
  resolveProductionTimingTarget,
  type ProductionTimingTarget,
} from "../e2e/helpers/production-target"

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function resolveOrExit(): ProductionTimingTarget {
  try {
    return resolveProductionTimingTarget(process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

const target = resolveOrExit()
console.log(`[prod-timing] ${describeProductionTimingTarget(target)}`)

const result = spawnSync(
  "npx",
  [
    "playwright",
    "test",
    "--config",
    "e2e/config/playwright.config.production.ts",
    ...process.argv.slice(2),
  ],
  { cwd: REPO_ROOT, stdio: "inherit" },
)

if (result.error) {
  console.error(`[prod-timing] failed to launch playwright: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
