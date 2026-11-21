export const WORKERS: string[]
/** The packages the replay gate and the auth matrix execute through. */
export const ENGINE: string[]

type Manifest = Record<string, unknown>

/** Problems with how `head`'s package.json differs from `base`'s; empty when only versions moved. */
export function manifestProblems(base: Manifest, head: Manifest): string[]

/** The version a pnpm lockfile resolves a direct dependency of its importer to. */
export function lockedVersion(lockfile: string, name: string): string | undefined

/** Problems when an ENGINE package resolves differently in the two lockfiles, or cannot be read. */
export function engineProblems(baseLock: string, headLock: string): string[]

/** Every problem for one worker directory, prefixed with its name. */
export function checkWorker(baseDir: string, headDir: string, worker: string): string[]
