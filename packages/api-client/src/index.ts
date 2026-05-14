// @aquilla/api-client — typed fetch wrappers for the Aquilla auth/sync APIs.
//
// Mirror of `src/lib/sync/*-read.ts` for use by discrete apps under apps/*.
// The workspace SPA in /src/ keeps using its local wrappers until Phase 3a
// migrates it onto this package.
//
// Pattern (Phase 2b):
//   - one wrapper per endpoint
//   - throws a named error on non-2xx (strict variants)
//   - returns null on non-2xx (graceful variants, e.g. invites)
//   - no React Query / SWR
//   - apps wire with vanilla useState + race-guarded effects
//
// Adding a new endpoint here: copy from the corresponding `src/lib/sync/*-read.ts`,
// keep the same error class + signature, and re-export from `index.ts`. Don't
// reuse the workspace SPA's wrappers via deep imports — packages are
// versioned shared concerns (AD-11).

export * from "./config"
export * from "./projects"
export * from "./members"
export * from "./orgs"
export * from "./invites"
