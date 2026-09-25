import { workersBuildPreviewAlias } from "./cloudflare-pr-preview.mjs"

const PREVIEW_WORKER = "aquilla-web-preview"
const PREVIEW_SUBDOMAIN = "blue-darkness-7674"

/**
 * Generate annotated tag message metadata for a production release tag.
 * @param {string} tag - The calver tag (e.g., "2026.09.23.00")
 * @param {string} branch - The release branch name (e.g., "release/2026/09/23")
 * @param {string} commitSha - The full commit SHA
 * @returns {string} Multi-line tag message
 */
export function generateTagMessage(tag, branch, commitSha) {
  if (!tag || !branch || !commitSha) {
    throw new Error("tag, branch, and commitSha are required")
  }

  const shortSha = commitSha.slice(0, 8)
  const repoOwner = "genesis-ai-dev"
  const repoName = "aquilla"
  const commitUrl = `https://github.com/${repoOwner}/${repoName}/commit/${commitSha}`
  const checksUrl = `https://github.com/${repoOwner}/${repoName}/commit/${commitSha}/checks`

  let previewUrl
  try {
    const alias = workersBuildPreviewAlias(branch)
    previewUrl = `https://${alias}-${PREVIEW_WORKER}.${PREVIEW_SUBDOMAIN}.workers.dev`
  } catch (error) {
    previewUrl = "unknown"
  }

  return `Production release ${tag}

Release branch: ${branch}
Deployed commit: ${shortSha} (${commitSha})
Commit URL: ${commitUrl}
Checks URL: ${checksUrl}
Preview URL: ${previewUrl}`.trim()
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const [tag, branch, commitSha] = process.argv.slice(2)
  
  if (!tag || !branch || !commitSha) {
    console.error("Usage: tag-metadata.mjs <tag> <branch> <commitSha>")
    process.exit(1)
  }

  try {
    console.log(generateTagMessage(tag, branch, commitSha))
  } catch (error) {
    console.error(`Error: ${error.message}`)
    process.exit(1)
  }
}
