import path from "node:path"

const CORE_SENTINELS = [
  "e2e/specs/projects/route-health.smoke.spec.ts",
  "e2e/specs/editor/workspace-actions-dropdown.smoke.spec.ts",
]

const DOMAIN_RULES: Array<{ source: RegExp; sentinels: string[] }> = [
  {
    // AQU-1479: captions, media bytes, and staged attachments publish together.
    source: /^(?:src\/lib\/import(?:\.ts|\/)|src\/lib\/parsers\/embedded-subtitles|src\/lib\/audio\/(?:align-source-script|script-alignment|source-alignment)|src\/components\/(?:ImportDialog|import\/|timeline\/TimelineEditor)|src\/hooks\/useTimelineTextCells|src\/lib\/sync\/bulk-import|sync-worker\/src\/audio\.ts|sync-worker\/src\/events\/import-(?:route|track-publication)|shared\/timeline-import)/i,
    sentinels: ["e2e/specs/editor/import-media-captions.smoke.spec.ts"],
  },
  {
    source: /^auth-worker\/src\/routes\/transcription\.ts$/i,
    sentinels: ["e2e/specs/editor/import-and-edit.smoke.spec.ts"],
  },
  {
    source: /^(?:src\/pages\/Login\.tsx|src\/components\/onboarding\/OnboardingWizard\.tsx|src\/.*billing|auth-worker\/.*billing|auth-worker\/src\/routes\/(?:chat|import-classify|agent|contextual|transcription)\.ts|auth-worker\/src\/lib\/agent\/(?:upstream|tools\/draft)\.ts|auth-worker\/src\/lib\/contextual\/tick\.ts|db\/shared\/(?:billing|workspace-access)|config\/pricing\/|auth-worker\/src\/services\/org-permissions\.ts|db\/postgres\/migrations\/.*(?:workspace_(?:billing|checkout|subscription|plan_change|usage)|weekly_allowance|live_workspace_checkout))/i,
    sentinels: ["e2e/specs/orgs/org-settings-billing.smoke.spec.ts"],
  },
  {
    // MCP OAuth (ChatGPT plugin) shares credential validation and browser consent.
    // Package changes also select this connection sentinel.
    source: /^(?:plugins\/aquilla\/|auth-worker\/.*(?:agent-connect|mcp-oauth)|db\/shared\/api-credentials|sync-worker\/src\/external\/(?:mcp|read-auth|token-bridge|orgs-list|projects-list|changesets-route|commit)|src\/.*(?:ConnectAgent|OAuthConsent|agent-access|agent-connect|ApiTokensSection)|db\/.*(?:agent_authorizations|mcp_oauth))/i,
    sentinels: ["e2e/specs/agent/agent-connection.smoke.spec.ts"],
  },
  {
    source: /^(?:auth-worker\/|src\/(?:pages|components|lib|hooks|context)\/.*(?:auth|account|login|signup|password|session|credential|outbox))/i,
    sentinels: [
      "e2e/specs/auth/login-account-setup-status.smoke.spec.ts",
      "e2e/specs/auth/session-expired-banner.smoke.spec.ts",
      "e2e/specs/orgs/account-switcher.smoke.spec.ts",
    ],
  },
  {
    source: /^(?:src\/(?:pages|components|lib)\/(?:org|team|preferences)|auth-worker\/.*(?:org|team|member))/i,
    sentinels: [
      "e2e/specs/orgs/account-switcher.smoke.spec.ts",
      "e2e/specs/orgs/members.smoke.spec.ts",
    ],
  },
  {
    // AQU-1153: the share / invite journey — Add a member (+ Invite link tab),
    // the org members page's "Add to projects" dialog, the recipient typeahead
    // they share, and /join/:token — has its own smoke spec, but none of these
    // files carry a domain keyword above, so they fell through to the core
    // sentinels and PR #882 shipped a stale locator in that spec ungated.
    source: /^(?:src\/components\/(?:UsernameTypeahead|MemberMultiAddRow|MultiProjectInviteDialog|ProjectMembersPage|ProjectSettings\/AddProjectMemberDialog|SharePanel|JoinPage)\.tsx|src\/hooks\/useUserSearch\.ts|src\/lib\/sync\/invites\.ts|auth-worker\/src\/(?:routes\/invites|services\/invite-scopes)\.ts)$/,
    sentinels: ["e2e/specs/projects/share-invite.smoke.spec.ts"],
  },
  {
    // AQU-1169: app-wide font size is device-scoped like theme; the persist-reload
    // journey is the cross-layer contract (boot script + Preferences control).
    source: /^(?:src\/(?:pages\/Preferences|branding\/FontSize|lib\/store\/file-view-prefs)|index\.html$)/,
    sentinels: ["e2e/specs/orgs/preferences-persist-reload.smoke.spec.ts"],
  },
  {
    source: /^(?:src\/(?:pages|components|lib)\/(?:project|onboarding|admin)|auth-worker\/.*project)/i,
    sentinels: ["e2e/specs/projects/route-health.smoke.spec.ts"],
  },
  {
    source: /^(?:src\/(?:components|lib)\/(?:rule|check|qa|lqa)|sync-worker\/.*(?:rule|validation|check))/i,
    sentinels: ["e2e/specs/rules/violation.smoke.spec.ts"],
  },
  {
    // Style-rule library + applicability graph (AQU-934). `src/lib/scripture`
    // (the book→genre map feeding applicability) matches no other domain.
    // NOTE: the graph's shared module lives at `db/shared/style-rules.ts`, and
    // `db/` sits outside PRODUCT_RUNTIME, so no domain rule can select for it —
    // same dead spot the `db/shared/knowledge` alternative above already has.
    // Its auth-worker route and client consumers are covered here instead.
    source: /^(?:auth-worker\/src\/routes\/style-rules|src\/lib\/scripture\/|src\/hooks\/useStyleRules)/i,
    sentinels: ["e2e/specs/rules/violation.smoke.spec.ts"],
  },
  {
    // BIA forecasting: ghost-text next words + "words that fit here". The
    // journey crosses the projection → SPA read → forecast worker → commit.
    source: /^src\/(?:lib\/forecast\/|lib\/richtext\/ghost-text|hooks\/useForecastCorpus|components\/WordsThatFitMenu|context\/ForecastContext|lib\/store\/ghost-text-pref)/,
    sentinels: ["e2e/specs/editor/ghost-text.spec.ts"],
  },
  {
    source: /^src\/(?:components|lib)\/(?:terminology|termbase)/i,
    sentinels: ["e2e/specs/terminology/wildcard-term-chip.smoke.spec.ts"],
  },
  {
    source: /^src\/(?:components|lib)\/(?:agent|chat|completion|brief)/i,
    sentinels: ["e2e/specs/ai/completion.smoke.spec.ts"],
  },
  {
    // AQU-657: document-understanding tags (and the route that asks for them)
    // reach a user through retrieval and few-shot selection, so they select the
    // AI predict journey rather than falling through to the generic
    // shared-runtime sentinel.
    source: /^(?:src\/lib\/understanding|auth-worker\/src\/routes\/ai-passage-tags)/i,
    sentinels: ["e2e/specs/ai/completion.smoke.spec.ts"],
  },
  {
    // AQU-1025: few-shot retrieval is the AI predict journey, not collab.
    source: /(?:sync-worker\/.*branching-search|src\/lib\/sync\/branching-search)/i,
    sentinels: ["e2e/specs/ai/completion.smoke.spec.ts"],
  },
  {
    source: /^(?:src\/(?:components|lib|pages)\/.*knowledge|auth-worker\/.*knowledge|db\/shared\/knowledge)/i,
    sentinels: ["e2e/specs/projects/project-settings.smoke.spec.ts"],
  },
  {
    // Living Memory surface (AQU-932): the Knowledge Base journey rides the
    // project-settings smoke spec's Living Memory leg.
    source: /^src\/components\/(?:living-memory\/|LivingMemory)/i,
    sentinels: ["e2e/specs/projects/project-settings.smoke.spec.ts"],
  },
  {
    source: /^(?:src\/(?:components|lib)\/(?:collab|sync|comments)|sync-worker\/)/i,
    sentinels: ["e2e/specs/collab/concurrent-edit.smoke.spec.ts"],
  },
  {
    source: /^src\/(?:components|lib)\/(?:validation|health|review)/i,
    sentinels: ["e2e/specs/validation/validate.smoke.spec.ts"],
  },
  {
    source: /^(?:src\/hooks\/useMediaPictureUrl\.|src\/lib\/sync\/bulk-import\.|sync-worker\/src\/events\/import-route\.)/,
    sentinels: ["e2e/specs/editor/import-and-edit.smoke.spec.ts"],
  },
  {
    // `parsers` and the partner integrations are the importer's own reading layer
    // — a change there only reaches a user through an import, so it selects the
    // import sentinel rather than falling through to the generic shared-runtime
    // one. Partner readers moved under `src/partner-integrations/` in AQU-1286.
    source: /^(?:src\/(?:components|lib)\/(?:editor|cell|workspace-actions|import|export|parsers|audio|voice|video|search|sidebar|timeline|storage)|src\/partner-integrations\/|packages\/idml)/i,
    sentinels: ["e2e/specs/editor/import-and-edit.smoke.spec.ts"],
  },
  {
    source: /(?:original-download|originals-bundle|file-original-download|useOriginalSourceFlags|original-source)/i,
    sentinels: ["e2e/specs/editor/export.smoke.spec.ts"],
  },
]

const NON_RUNTIME = /^(?:docs\/|\.github\/|\.claude\/|\.agents\/|test-results|playwright-report|.*\.(?:md|mdx|txt|png|jpe?g|gif|svg|mp4|mov|csv))$/i
const UNIT_TEST = /(?:^|\/)(?:__tests__\/.*|[^/]+\.(?:test|spec)\.[cm]?[jt]sx?)$/i
const E2E_INFRA = /^(?:e2e\/(?:config|helpers|reporters)\/|scripts\/(?:e2e-|lib\/spawn-worker)|package\.json$|pnpm-lock\.yaml$|vite\.config|tsconfig)/i
const PRODUCT_RUNTIME = /^(?:plugins\/aquilla\/|db\/shared\/api-credentials|db\/postgres\/migrations\/.*mcp_oauth|src\/|auth-worker\/|sync-worker\/|packages\/|shared\/timeline-import|index\.html$|config\/pricing\/|db\/shared\/(?:billing|workspace-access)|db\/postgres\/migrations\/.*(?:workspace_(?:billing|checkout|subscription|plan_change|usage)|weekly_allowance|live_workspace_checkout))/

function normalize(file: string): string {
  return file.trim().replaceAll("\\", "/").replace(/^\.\//, "")
}

function tokensFor(file: string): string[] {
  const basename = path.posix.basename(file).replace(/\.(?:smoke\.)?spec\.tsx?$/, "").replace(/\.[^.]+$/, "")
  return basename
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 5 && !["component", "dialog", "section", "index", "route", "button"].includes(token))
}

function closestSpecs(file: string, smokeSpecs: string[]): string[] {
  const tokens = tokensFor(file)
  if (tokens.length === 0) return []
  return smokeSpecs
    .map((spec) => ({
      spec,
      score: tokens.reduce((score, token) => score + (spec.toLowerCase().includes(token) ? 1 : 0), 0),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.spec.localeCompare(b.spec))
    // The changed journey spec itself is selected directly by the normal
    // behavior-change contract. This lexical fallback adds just one nearby
    // regression so routine pushes stay inside the feedback budget.
    .slice(0, 1)
    .map(({ spec }) => spec)
}

export interface E2EImpact {
  specs: string[]
  reasons: string[]
}

export function selectAffectedE2E(changedFiles: string[], availableSmokeSpecs: string[]): E2EImpact {
  const smokeSpecs = availableSmokeSpecs.map(normalize).sort()
  const available = new Set(smokeSpecs)
  const selected = new Set<string>()
  const reasons: string[] = []

  const add = (specs: string[], reason: string): void => {
    const existing = specs.filter((spec) => available.has(spec))
    if (existing.length === 0) return
    existing.forEach((spec) => selected.add(spec))
    reasons.push(`${reason}: ${existing.join(", ")}`)
  }

  for (const rawFile of changedFiles) {
    const file = normalize(rawFile)
    if (!file) continue

    if (file === "src/components/CellActionRail.tsx") {
      add(["e2e/specs/editor/comments.smoke.spec.ts"], `${file} exposes the cell comment menu`)
    }
    if (/^(?:smart-tests\/|scripts\/smart-tests(?:-pr|-parallel)?\.(?:ts|mjs)$|scripts\/smart-test-comment\.mjs$)/.test(file)) {
      add(["e2e/specs/editor/import-and-edit.smoke.spec.ts"], `${file} affects smart testing`)
      continue
    }

    if (/^e2e\/specs\/.*\.smoke\.spec\.tsx?$/.test(file)) {
      add([file], `${file} changed`)
      continue
    }
    if (NON_RUNTIME.test(file) || UNIT_TEST.test(file)) continue
    if (E2E_INFRA.test(file)) {
      add(CORE_SENTINELS, `${file} affects the E2E harness`)
      continue
    }

    if (PRODUCT_RUNTIME.test(file)) {
      const matchingRules = DOMAIN_RULES.filter(({ source }) => source.test(file))
      add(
        matchingRules.length > 0 ? matchingRules.flatMap(({ sentinels }) => sentinels) : CORE_SENTINELS,
        `${file} affects ${matchingRules.length > 0 ? "a product domain" : "shared runtime code"}`,
      )
      add(closestSpecs(file, smokeSpecs), `${file} filename matches`)
    }
  }

  return { specs: [...selected].sort(), reasons }
}
