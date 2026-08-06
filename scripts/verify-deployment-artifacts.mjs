import { readFileSync, readdirSync, rmSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

const FORBIDDEN_NAMES = new Set([
  ".ds_store",
  ".spotlight-v100",
  ".trashes",
  "__macosx",
  "desktop.ini",
  "ehthumbs.db",
  "icon\r",
  "thumbs.db",
])

export const REQUIRED_ASSET_IGNORE_PATTERNS = Object.freeze([
  ".DS_Store",
  "._*",
  "Thumbs.db",
  "desktop.ini",
  "ehthumbs.db",
  "Icon?",
  "__MACOSX/",
  ".Spotlight-V100/",
  ".Trashes/",
])

export function isForbiddenDeploymentArtifactName(name) {
  const normalized = String(name).normalize("NFC").toLowerCase()
  return FORBIDDEN_NAMES.has(normalized) || normalized.startsWith("._")
}

function portableRelativePath(root, entryPath) {
  return relative(root, entryPath).split(sep).join("/")
}

export function findForbiddenDeploymentArtifacts(directory) {
  const root = resolve(directory)
  const violations = []

  function visit(currentDirectory) {
    for (const entry of readdirSync(currentDirectory, { withFileTypes: true })) {
      const entryPath = resolve(currentDirectory, entry.name)
      if (isForbiddenDeploymentArtifactName(entry.name)) {
        violations.push(portableRelativePath(root, entryPath))
        continue
      }
      if (entry.isDirectory()) visit(entryPath)
    }
  }

  visit(root)
  return violations.sort()
}

export function assertSafeDeploymentArtifacts(directory) {
  const root = resolve(directory)
  const ignorePath = resolve(root, ".assetsignore")
  let ignorePatterns
  try {
    ignorePatterns = new Set(
      readFileSync(ignorePath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    )
  } catch (error) {
    throw new Error(
      `refusing to deploy ${root}: cannot read required .assetsignore policy (${error instanceof Error ? error.message : String(error)})`,
    )
  }

  const missingPatterns = REQUIRED_ASSET_IGNORE_PATTERNS.filter((pattern) => !ignorePatterns.has(pattern))
  if (missingPatterns.length > 0) {
    throw new Error(
      `refusing to deploy ${root}: .assetsignore is missing required workstation metadata patterns:\n${missingPatterns.map((pattern) => `- ${pattern}`).join("\n")}`,
    )
  }

  return {
    directory: root,
    excludedMetadata: findForbiddenDeploymentArtifacts(root),
  }
}

export function preparePagesDeploymentArtifacts(directory) {
  const root = resolve(directory)
  const removedMetadata = findForbiddenDeploymentArtifacts(root)

  for (const relativePath of removedMetadata) {
    rmSync(resolve(root, relativePath), { recursive: true, force: true })
  }

  // `.assetsignore` is a Workers Assets policy file. Pages does not consume it,
  // so do not expose that internal deployment policy as a public site asset.
  rmSync(resolve(root, ".assetsignore"), { force: true })

  const remainingMetadata = findForbiddenDeploymentArtifacts(root)
  if (remainingMetadata.length > 0) {
    throw new Error(
      `refusing to deploy ${root} to Pages: workstation metadata remains after preparation:\n${remainingMetadata.map((path) => `- ${path}`).join("\n")}`,
    )
  }

  return { directory: root, removedMetadata }
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  try {
    const directory = process.argv.find((argument, index) => index > 1 && !argument.startsWith("--")) ?? "dist"
    if (process.argv.includes("--pages")) {
      const result = preparePagesDeploymentArtifacts(directory)
      console.log(
        `[verify-deployment-artifacts] ${result.directory} removed ${result.removedMetadata.length} workstation metadata path(s) before the Pages upload`,
      )
    } else {
      const result = assertSafeDeploymentArtifacts(directory)
      console.log(
        `[verify-deployment-artifacts] ${result.directory} excludes ${result.excludedMetadata.length} workstation metadata path(s) through .assetsignore`,
      )
    }
  } catch (error) {
    console.error(`[verify-deployment-artifacts] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
