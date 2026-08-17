import { describe, expect, it } from "vitest"
import { isScannableFile, scanSource } from "./i18n-scan"

function findText(findings: ReturnType<typeof scanSource>, text: string) {
  return findings.find((f) => f.text.includes(text))
}

describe("i18n-scan: class 1 — template literals with expressions", () => {
  it("flags an interpolated template passed to toast.error", () => {
    const src = `
      function onDelete(n: number) {
        toast.error(\`Deleted \${n} files\`)
      }
    `
    const findings = scanSource("src/components/Foo.tsx", src)
    const hit = findText(findings, "Deleted")
    expect(hit).toBeDefined()
    expect(hit?.class).toBe("tmpl-expr")
    expect(hit?.confidence).toBe("high")
  })

  it("flags an interpolated template on a translatable JSX attribute", () => {
    const src = `
      function Row({ username }: { username: string }) {
        return <button aria-label={\`Remove \${username}\`} />
      }
    `
    const findings = scanSource("src/components/Row.tsx", src)
    const hit = findText(findings, "Remove")
    expect(hit).toBeDefined()
    expect(hit?.class).toBe("tmpl-expr")
  })

  it("does not flag a template whose static quasis are punctuation-only", () => {
    // `${label}:` -> skeleton is just ":" once the expression is dropped.
    const src = `
      function Field({ label }: { label: string }) {
        return <span title={\`\${label}:\`} />
      }
    `
    const findings = scanSource("src/components/Field.tsx", src)
    expect(findings).toHaveLength(0)
  })

  it("does not flag an interpolated template with no UI-facing evidence", () => {
    const src = `
      function buildUrl(id: string) {
        return \`https://example.com/projects/\${id}\`
      }
    `
    const findings = scanSource("src/lib/urls.ts", src)
    expect(findings).toHaveLength(0)
  })
})

describe("i18n-scan: class 2 — hoisted const arrays/objects", () => {
  it("flags a label in a top-level const array of option objects", () => {
    const src = `
      const ROLE_OPTIONS = [
        { value: "owner", label: "Owner", description: "Full access to everything." },
        { value: "viewer", label: "Viewer" },
      ]
      export function RoleSelect() {
        return <select>{ROLE_OPTIONS.map((o) => <option key={o.value}>{o.label}</option>)}</select>
      }
    `
    const findings = scanSource("src/components/RoleSelect.tsx", src)
    expect(findText(findings, "Owner")?.class).toBe("hoisted-const")
    expect(findText(findings, "Full access")?.class).toBe("hoisted-const")
    // structural keys sitting next to the real label must not be reported
    expect(findText(findings, "owner")).toBeUndefined()
    expect(findText(findings, "viewer")).toBeUndefined()
  })

  it("flags a flat hoisted vocabulary map by variable-name convention", () => {
    const src = `
      const STATUS_LABELS = {
        active: "Active",
        pending: "Pending review",
      }
    `
    const findings = scanSource("src/components/Status.tsx", src)
    expect(findText(findings, "Active")?.class).toBe("hoisted-const")
    expect(findText(findings, "Pending review")?.class).toBe("hoisted-const")
  })

  it("does not flag a hoisted Tailwind class lookup table", () => {
    const src = `
      const textClasses: Record<Size, string> = {
        xs: "text-[10px] font-semibold",
        lg: "text-sm font-semibold",
      }
    `
    const findings = scanSource("src/components/Avatar.tsx", src)
    expect(findings).toHaveLength(0)
  })

  it("does not flag strings inside a function body (not hoisted)", () => {
    const src = `
      function Widget() {
        const localOptions = [{ label: "Owner" }]
        return <div>{localOptions[0].label}</div>
      }
    `
    const findings = scanSource("src/components/Widget.tsx", src)
    expect(findings).toHaveLength(0)
  })
})

describe("i18n-scan: class 3 — non-.tsx files", () => {
  it("flags a translatable property in a plain .ts file", () => {
    const src = `
      export const AUDIO_ERRORS = {
        quotaExceeded: { title: "Daily AI limit reached", message: "Try again tomorrow." },
      }
    `
    const findings = scanSource("src/lib/audio/ai-error.ts", src)
    expect(findText(findings, "Daily AI limit reached")?.class).toBe("non-tsx")
    expect(findText(findings, "Try again tomorrow")?.class).toBe("non-tsx")
  })

  it("flags a toast call in a plain .ts file", () => {
    const src = `
      export function notifyDone() {
        toast.success("Import finished")
      }
    `
    const findings = scanSource("src/lib/import/notify.ts", src)
    expect(findText(findings, "Import finished")?.class).toBe("non-tsx")
  })

  it("does not flag a console.error call", () => {
    const src = `
      export function guard(x: unknown) {
        console.error("unexpected shape for internal cache entry", x)
      }
    `
    const findings = scanSource("src/lib/cache.ts", src)
    expect(findings).toHaveLength(0)
  })

  it("does not flag a developer-facing Error message", () => {
    const src = `
      export function assertProjectId(id: string | undefined): asserts id is string {
        if (!id) throw new Error("projectId is required in this context")
      }
    `
    const findings = scanSource("src/lib/assert.ts", src)
    expect(findings).toHaveLength(0)
  })

  it("does not flag a string-literal type union", () => {
    const src = `
      export type ImportStatus = "pending" | "running" | "done" | "failed"
      export interface Job {
        kind: "import" | "export"
      }
    `
    const findings = scanSource("src/lib/import/types.ts", src)
    expect(findings).toHaveLength(0)
  })

  it("does not flag a SQL tagged template", () => {
    const src = `
      export function loadProject(id: string) {
        return sql\`select * from projects where id = \${id}\`
      }
    `
    const findings = scanSource("src/lib/db/queries.ts", src)
    expect(findings).toHaveLength(0)
  })
})

describe("i18n-scan: class 4 — ignored files (policy exemptions)", () => {
  it("classifies findings in an admin-only surface as exempt-admin-dev", () => {
    const src = `
      export function AdminPanel() {
        return <div title="Internal staff tooling only">Danger zone</div>
      }
    `
    const findings = scanSource("src/components/admin/AdminPanel.tsx", src)
    const hit = findText(findings, "Internal staff tooling only")
    expect(hit?.class).toBe("ignored-file")
    expect(hit?.classification).toBe("exempt-admin-dev")
  })

  it("classifies findings in the privacy policy page as exempt-legal", () => {
    const src = `
      export function PrivacyPolicy() {
        return <p>We take your privacy seriously.</p>
      }
    `
    const findings = scanSource("src/pages/PrivacyPolicy.tsx", src)
    const hit = findText(findings, "We take your privacy seriously")
    expect(hit?.class).toBe("ignored-file")
    expect(hit?.classification).toBe("exempt-legal")
  })

  it("still enumerates a toast call inside an ignored file", () => {
    const src = `
      export function DevLoginRoute() {
        toast.error("Dev login is unavailable in this environment")
        return null
      }
    `
    const findings = scanSource("src/components/DevLoginRoute.tsx", src)
    const hit = findText(findings, "Dev login is unavailable")
    expect(hit?.class).toBe("ignored-file")
  })
})

describe("i18n-scan: known-good strings are never reported", () => {
  it("does not flag atomic terms / product names", () => {
    const src = `
      const FORMATS = { usfm: { label: "USFM" }, mp3: { label: "MP3" } }
    `
    const findings = scanSource("src/components/Formats.tsx", src)
    expect(findings).toHaveLength(0)
  })

  it("does not flag camelCase or CONST_CASE identifiers used as values", () => {
    const src = `
      const CONFIG = { mode: "autoSaveEnabled", LEVEL: "MAX_RETRY_COUNT" }
    `
    const findings = scanSource("src/components/Config.tsx", src)
    expect(findings).toHaveLength(0)
  })

  it("does not flag a log message even when it looks sentence-like", () => {
    const src = `
      function warmCache() {
        console.warn("cache warm-up took longer than expected, continuing anyway")
      }
    `
    const findings = scanSource("src/lib/cache-warm.ts", src)
    expect(findings).toHaveLength(0)
  })

  it("excludes test fixture files from the walk (Deliverable 1 requirement)", () => {
    // The scanner never even opens these files — verified at the file-walk
    // predicate, since `scanSource` (called directly in these tests) always
    // scans whatever source it's handed.
    expect(isScannableFile("Foo.test.tsx")).toBe(false)
    expect(isScannableFile("foo.spec.ts")).toBe(false)
    expect(isScannableFile("useThing.test.ts")).toBe(false)
    expect(isScannableFile("Widget.tsx")).toBe(true)
    expect(isScannableFile("utils.ts")).toBe(true)
    expect(isScannableFile("styles.css")).toBe(false)
  })
})
