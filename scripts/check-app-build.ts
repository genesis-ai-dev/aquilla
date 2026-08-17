import { readdirSync } from "node:fs"
import { resolve } from "node:path"
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
}
