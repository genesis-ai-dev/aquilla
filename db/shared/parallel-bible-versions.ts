// The project's default Parallel Bibles versions — the helloao translation ids
// a translator sees in the Parallel Bibles panel until they pin their own.
//
// A project lead (500)+ may set them: which comparison Bibles the team reads
// beside the draft is the lead's call, and the key hands them nothing else
// (auth-worker/src/routes/project-settings.ts carve-out). Stored in the
// project-settings JSON blob, so there is no column and no migration.
//
// Pure and dependency-free so both workers and the SPA can import it.

export const PARALLEL_BIBLE_VERSIONS_KEY = 'parallelBibleVersions'

/** More than this is not a reading list, it is the catalogue. */
export const MAX_PARALLEL_BIBLE_VERSIONS = 12

/** helloao ids are short codes ("BSB", "grc_sbl", "hbo_wlc"). */
const MAX_VERSION_ID_LENGTH = 64

export const PARALLEL_BIBLE_VERSIONS_TYPE_NAME =
  `string[] (helloao translation ids, at most ${MAX_PARALLEL_BIBLE_VERSIONS}, no duplicates)`

/** Null when the value is a valid list of version ids, else what is wrong. */
export function parallelBibleVersionsProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return 'not a list of version ids'
  if (value.length > MAX_PARALLEL_BIBLE_VERSIONS) {
    return `at most ${MAX_PARALLEL_BIBLE_VERSIONS} versions`
  }
  const seen = new Set<string>()
  for (const id of value) {
    if (typeof id !== 'string' || id.trim() === '' || id.length > MAX_VERSION_ID_LENGTH) {
      return 'every entry must be a non-empty version id'
    }
    if (seen.has(id)) return `"${id}" is listed twice`
    seen.add(id)
  }
  return null
}
