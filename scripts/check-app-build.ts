import { readdirSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const FORBIDDEN_ROOT_OUTPUTS = new Set([
  "homepage.html",
  "beta.html",
  "bible-translation.html",
  "case-study.html",
  "case-study-biblica.html",
  "sitemap.xml",
  "robots.txt",
  "mkt",
])

/** Assert that the app deploy contains no artifacts owned by aquilla-marketing. */
export function findMarketingBuildArtifacts(directory: string): string[] {
  return readdirSync(directory)
    .map((entry) => entry.toLowerCase())
    .filter((entry) => FORBIDDEN_ROOT_OUTPUTS.has(entry))
    .sort()
}

/**
 * Cloudflare Workers static assets cap each file at 25 MiB; `wrangler deploy`
 * and `wrangler preview` reject the whole upload over it ("Asset too large").
 */
export const WORKERS_ASSET_SIZE_LIMIT_BYTES = 25 * 1024 * 1024

export type OversizedAsset = { path: string; bytes: number }

/**
 * Every file under the build output that Workers would refuse to upload. The
 * usual offender is a dependency bump growing a bundled WASM runtime: the
 * onnxruntime-web build inside `@huggingface/transformers` 4.3.0 went from
 * 22.5 to 25.6 MiB and took every preview and deploy build down with it.
 */
export function findOversizedAssets(
  directory: string,
  limitBytes: number = WORKERS_ASSET_SIZE_LIMIT_BYTES,
): OversizedAsset[] {
  const oversized: OversizedAsset[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(absolute)
        continue
      }
      const bytes = statSync(absolute).size
      if (bytes > limitBytes) {
        oversized.push({ path: relative(directory, absolute).replaceAll("\\", "/"), bytes })
      }
    }
  }
  walk(directory)
  return oversized.sort((left, right) => left.path.localeCompare(right.path))
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  const directory = resolve(process.cwd(), process.argv[2] ?? "dist")
  const marketingArtifacts = findMarketingBuildArtifacts(directory)
  if (marketingArtifacts.length > 0) {
    console.error(
      `[check-app-build] ${directory} contains marketing-owned artifacts: ${marketingArtifacts.join(", ")}`,
    )
    process.exitCode = 1
  } else {
    console.log("[check-app-build] SPA-only output OK")
  }

  const oversizedAssets = findOversizedAssets(directory)
  if (oversizedAssets.length > 0) {
    const toMiB = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1)
    console.error(
      `[check-app-build] ${directory} has assets over the ${toMiB(WORKERS_ASSET_SIZE_LIMIT_BYTES)} MiB Cloudflare Workers limit: ${oversizedAssets
        .map((asset) => `${asset.path} (${toMiB(asset.bytes)} MiB)`)
        .join(", ")}`,
    )
    process.exitCode = 1
  } else {
    console.log("[check-app-build] asset sizes OK")
  }
}
