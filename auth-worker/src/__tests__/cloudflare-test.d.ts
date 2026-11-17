// Types for `cloudflare:test`. The tests never run in the Workers pool:
// vitest.config.ts aliases this module to the PGlite shim in
// helpers/pg-test-env.ts. Declaring only what the suites import here, instead
// of pulling in @cloudflare/vitest-pool-workers for its types, keeps auth-worker
// free of that package's vitest@4 peer pin (it blocks `npm ci` on vitest 5).
declare module "cloudflare:test" {
  export const env: Cloudflare.Env

  export interface D1Migration {
    name: string
    queries: string[]
  }
}
