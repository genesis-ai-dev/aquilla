// Shared types for the aquilla-identity worker.
//
// A single Postgres database (Neon) owns everything codex-web touches —
// identity, orgs, projects, members, invites, plus the file/cell projections
// the sync worker writes. Schema lives in `db/postgres/schema.sql`.

/**
 * Minimal surface of the Cloudflare Email Service `send_email` binding
 * (public beta 2026-04). The pinned @cloudflare/workers-types predates
 * Email Service — its legacy `SendEmail` type only accepts an
 * `EmailMessage` — so just the object-form `send()` we call is typed here.
 */
export interface EmailService {
  send(message: {
    from: string
    to: string[]
    subject: string
    html?: string
    text?: string
  }): Promise<{ messageId: string }>
}

export interface Env {
  /** The Postgres (Neon) handle, served by the shim in db/shim/postgres.ts.
   *  Injected per-request in index.ts from HYPERDRIVE; the sync worker uses the
   *  same database. NOT a binding itself. */
  AQUILLA_PG: AquillaDb

  /** Postgres (Neon) via Hyperdrive — the sole datastore. index.ts builds
   *  AQUILLA_PG from this; required (the worker fails fast when absent). */
  HYPERDRIVE?: Hyperdrive

  // Frontier JWT signing. Rotated for the clean break — tokens minted by
  // the legacy frontier-server no longer verify here.
  SECRET_KEY: string
  ALGORITHM: string
  ACCESS_TOKEN_EXPIRE_MINUTES: string

  // Sync-token signing AND admin auth to aquilla-sync-worker. Shared
  // between identity and the sync worker.
  SYNC_SECRET_KEY?: string

  /** aquilla-sync-worker base URL for archive / file-delete notifications. */
  SYNC_WORKER_URL?: string

  /** Cloudflare Email Service `send_email` binding — password reset and
   *  project invites. Declared only in deployed env blocks (wrangler.toml);
   *  absent in local/e2e profiles, where invites no-op and password reset
   *  fails the same way it did without a Resend key. */
  EMAIL?: EmailService
  EMAIL_FROM?: string
  BASE_URL?: string

  /** Public invite link to the community (Discord). When set, the welcome
   *  email includes a "join the community" CTA; when absent the email simply
   *  omits it (no dead link). Plain config var, not a secret. */
  DISCORD_INVITE_URL?: string

  ENVIRONMENT?: string

  /**
   * Comma-separated allowlist of ACCOUNT EMAILS granted platform-operator
   * (site-wide admin) access — see middleware/platform-admin.ts and
   * routes/admin.ts. Identity is by email; usernames don't matter. This is a
   * SEPARATE axis from the org-scoped role ladder (ROLE below): a platform admin
   * can read across every org/user, which the 100–700 levels never confer. Kept
   * in deploy config rather than a DB column so god-mode can't be granted by a
   * stray SQL write; empty/unset means no platform admins exist. Emails are
   * trimmed + lowercased for matching.
   */
  ADMIN_EMAILS?: string

  /**
   * Step-up "sudo" switch (middleware/platform-admin.ts). When "true", the
   * `/api/v2/admin/*` console additionally requires a fresh emailed 6-digit code
   * (→ a ~6h elevated session) before any data/config route. Bypassed under
   * WRANGLER_LOCAL=1 (local dev-stack / e2e). Independent of WHO is an admin
   * (ADMIN_EMAILS) — that's always enforced; this only governs the extra step-up.
   * Set it "true" in production/staging.
   */
  ADMIN_REQUIRE_ELEVATION?: string
  /** Minutes a step-up code is valid for entry. Default: 10. */
  ELEVATION_TTL_MINUTES?: string
  /** Hours an elevated admin session lasts after a successful verify. Default: 6. */
  ELEVATION_SESSION_HOURS?: string

  // Chat-completion proxy (folded in from the former aquilla-chat-worker
  // on 2026-05-26 — see routes/chat.ts).
  OPENROUTER_API_KEY?: string
  DEFAULT_LLM_MODEL?: string
  /** Fallback model for the translation agent (routes/agent.ts) when
   *  platform_settings.agentModel is unset. Default: anthropic/claude-haiku-4-5. */
  AGENT_MODEL_DEFAULT?: string
  /** Dev/e2e only: override the OpenRouter API base (e.g. the scripted mock
   *  in scripts/mock-openrouter.ts). Never set in prod. */
  OPENROUTER_BASE_URL?: string
  /** Injected by index.ts (never configured): raw Postgres connection string
   *  so streaming routes can open a connection that outlives the Response. */
  PG_CONNECTION_STRING?: string

  // AI budget + allowlist controls (FRO-265).
  // AI_ALLOWED_MODELS: comma-separated list of permitted OpenRouter model IDs.
  //   Unset → uses the hardcoded default list in lib/ai-budget.ts.
  AI_ALLOWED_MODELS?: string
  // AI_USER_DAILY_REQUEST_LIMIT: max requests per user per UTC day. Default: 500.
  AI_USER_DAILY_REQUEST_LIMIT?: string
  // AI_GLOBAL_DAILY_REQUEST_LIMIT: aggregate daily ceiling across all users. Default: 5000.
  AI_GLOBAL_DAILY_REQUEST_LIMIT?: string
  // AI_BUDGET_ENFORCE: set to "true" to enforce limits with 429s.
  //   Default (unset / "false"): LOG-ONLY mode — over-budget requests are logged
  //   but allowed through. Flip to "true" after sizing thresholds.
  AI_BUDGET_ENFORCE?: string

  // ── Bible Aquifer reference data (bibletranslation.org) ──────────────────
  // Server-side proxy + agent integration of our scholarly reference API,
  // gated per-project by project_settings.bibleResourcesEnabled (default off).
  // See docs/superpowers/specs/2026-06-13-aquifer-integration-design.md.
  /** Base origin for the Aquifer API. Default https://bibletranslation.org.
   *  Overridden in dev/e2e to point at scripts/mock-aquifer.ts. */
  AQUIFER_BASE_URL?: string
  /** User-Agent sent to the Aquifer API — the live site 403s generic UAs.
   *  Default: "Aquilla/1.0 (+https://aquilla.app)". */
  AQUIFER_USER_AGENT?: string

  // ── Org credit accounting (WS-AUTH-CREDITS) ──────────────────────────────
  // Platform-level defaults; per-org overrides live in org_settings.credits.
  // CREDIT_MARKUP: base markup multiplier for llm/tts rails. Default: 4.
  CREDIT_MARKUP?: string
  // CREDIT_AGENT_MARKUP: markup multiplier for the agent rail. Default: 5.
  CREDIT_AGENT_MARKUP?: string
  // CREDIT_DAILY_CAP: org daily cap in credits (all rails). Default: 1000.
  CREDIT_DAILY_CAP?: string
  // CREDIT_WEEKLY_CAP: org rolling-7-day cap in credits (all rails). Default: 5000.
  CREDIT_WEEKLY_CAP?: string
  // CREDIT_AGENT_DAILY_CAP: agent-rail daily sub-cap in credits. Default: 600.
  CREDIT_AGENT_DAILY_CAP?: string
  // CREDIT_AGENT_WEEKLY_CAP: agent-rail rolling-7-day sub-cap. Default: 3000.
  CREDIT_AGENT_WEEKLY_CAP?: string
  // CREDIT_ENFORCE: set to "true" to enforce caps with 429s. Default: false.
  CREDIT_ENFORCE?: string

  /**
   * When set to "1", exposes `/__test__/reset` and skips authentication on
   * sensitive routes that the E2E harness needs to seed. NEVER set in
   * production — gated explicitly so an accidental config flip doesn't
   * expose admin routes.
   */
  WRANGLER_LOCAL?: string
}

export type Variables = {
  user: AuthUser
}

/**
 * Row shape of the `users` table. Mirrors the schema in
 * `apps/identity/migrations/0001_initial.sql`. Legacy gitlab_* / stripe_*
 * columns were removed in the clean-break migration (2026-05-13).
 */
export interface UserRow {
  id: number
  username: string
  email: string
  password_hash: string
  preferences: string
  created_at: string
  updated_at: string
}

/** Hydrated user injected into request context by `authMiddleware`. */
export interface AuthUser {
  id: number
  username: string
  email: string
  password_hash: string
  preferences: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface UserResponse {
  id: number
  username: string
  email: string
  preferences: Record<string, unknown>
}

export interface AuthResponse {
  access_token: string
  token_type: "bearer"
}

export interface JWTPayload {
  /** Username — sub claim. */
  sub: string
  exp: number
  iat: number
  [k: string]: unknown
}

/**
 * Sync-token claim shape — must match apps/sync/src/auth.ts.
 * See `docs/SYNC.md` (this repo) for the security model.
 */
export interface SyncTokenClaims {
  userId: number
  username: string
  projectId: string
  fileId: string
  role: number
  aud: "sync"
  iat: number
  exp: number
}

/**
 * Resolved project-role with attribution. Per AD-12 (max-wins resolution
 * across direct + group + org + creator paths), `source` is the path that
 * produced the winning role; ties resolve in declaration order
 * (`override` > `group` > `org` > `creator`) so an explicit grant gets
 * attribution credit when it ties with an inherited one. UIs that need to
 * show every contributing path should call the resolver's `breakdown`
 * helper instead of reading `source` alone.
 *
 * `"platform"` is the ADMIN_EMAILS allowlist path (owner-level on every
 * project, see middleware/platform-admin.ts). Lowest tie priority, so a
 * genuine grant keeps attribution when the admin is also a real member.
 */
export interface RoleResolution {
  level: number
  name: string
  source: "override" | "group" | "org" | "creator" | "platform"
}

export interface SyncTokenResponse {
  token: string
  expiresIn: number
  role: RoleResolution
}

/** Row shape of `project_invites`. */
export interface ProjectInviteRow {
  token: string
  project_id: string
  role_level: number
  created_by: number
  created_at: string
  expires_at: string | null
  used_by: number | null
  used_at: string | null
  /** Optional recipient the invite was minted for; null for open links. */
  email: string | null
}

/** Row shape of `project_members`. */
export interface ProjectMemberRow {
  project_id: string
  user_id: number
  role_level: number
  granted_by: number | null
  granted_at: string
}

/** Row shape of `projects` — only the columns we read. */
export interface ProjectRow {
  id: string
  name: string
  org_id: number | null
  created_by: number
  archived_at: string | null
}

/** Numeric ladder; mirrors src/lib/frontier/roles.ts and apps/sync/. */
export const ROLE = {
  VIEWER: 100,
  COMMENTER: 200,
  REVIEWER: 300,
  CONTRIBUTOR: 400,
  PROJECT_LEAD: 500,
  MAINTAINER: 600,
  OWNER: 700,
} as const

/** Hard cap for link-share invites: never grant managerial roles via URL. */
export const LINK_ROLE_CAP = ROLE.CONTRIBUTOR

/** Minimum role required to mint a share-link invite for a project. */
export const INVITE_MIN_ROLE = ROLE.PROJECT_LEAD
