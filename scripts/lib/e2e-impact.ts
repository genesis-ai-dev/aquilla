import path from "node:path"

const CORE_SENTINELS = [
  "e2e/specs/projects/route-health.smoke.spec.ts",
  "e2e/specs/editor/workspace-actions-dropdown.smoke.spec.ts",
]

const DOMAIN_RULES: Array<{ source: RegExp; sentinels: string[] }> = [
  {
    source: /^(?:auth-worker\/.*agent-connect|src\/.*(?:ConnectAgent|agent-connect|ApiTokensSection)|db\/.*agent_authorizations)/i,
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
    source: /^src\/(?:components|lib)\/(?:terminology|termbase)/i,
    sentinels: ["e2e/specs/terminology/wildcard-term-chip.smoke.spec.ts"],
  },
  {
    source: /^src\/(?:components|lib)\/(?:agent|chat|completion|brief)/i,
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
    // `parsers`/`biblica` are the importer's own reading layer — a change there
    // only reaches a user through an import, so it selects the import sentinel
    // rather than falling through to the generic shared-runtime one.
    source: /^(?:src\/(?:components|lib)\/(?:editor|cell|workspace-actions|import|export|parsers|biblica|audio|voice|video|search|sidebar|timeline|storage)|packages\/idml)/i,
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
const PRODUCT_RUNTIME = /^(?:src\/|auth-worker\/|sync-worker\/|packages\/|index\.html$)/

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
