// Contract test for the ChatGPT / Codex plugin package (plugins/aquilla).
//
// The package is static files that no build step reads, so nothing else
// notices when it drifts: a renamed MCP tool leaves the skills calling a tool
// that no longer exists, and a moved endpoint leaves the plugin pointing at
// nothing. This test ties the package to the code it describes.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import deploymentManifest from "../config/cloudflare-deployments.json"
import { CHATGPT_TOOLS as MCP_TOOLS } from "../sync-worker/src/external/mcp-chatgpt-tools"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "aquilla")
const read = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8")

interface PluginManifest {
  name: string
  version: string
  skills: string
  mcpServers: string
  author: { name: string }
  extensions: { "com.openai": { review: { test_cases: { positive: { tools_triggered: string }[]; negative: object[] } } } }
  interface: Record<string, unknown> & { defaultPrompt: string[]; composerIcon: string; logo: string }
}
const manifest = JSON.parse(read(".codex-plugin", "plugin.json")) as PluginManifest
const skillDirs = readdirSync(path.join(ROOT, "skills"))

describe("plugin manifest", () => {
  it("satisfies listing field limits and Codex capability requirements", () => {
    expect(String(manifest.interface.shortDescription).length).toBeLessThanOrEqual(30)
    expect(String(manifest.interface.displayName).length).toBeLessThanOrEqual(30)
    expect(manifest.author.name).toBe("Frontier R&D Ltd.")
    expect(Array.isArray(manifest.interface.capabilities)).toBe(true)
    for (const key of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
      expect(String(manifest.interface[key])).toMatch(/^https:\/\//)
    }
  })

  it("points only at files inside the package, written ./relative", () => {
    for (const ref of [manifest.skills, manifest.mcpServers, manifest.interface.composerIcon, manifest.interface.logo]) {
      expect(ref).toMatch(/^\.\//)
      expect(ref).not.toContain("..")
      expect(existsSync(path.join(ROOT, ref))).toBe(true)
    }
  })

  it("keeps the starter prompts within the directory's limits (3 prompts, 128 chars)", () => {
    expect(manifest.interface.defaultPrompt.length).toBeLessThanOrEqual(3)
    for (const prompt of manifest.interface.defaultPrompt) expect(prompt.length).toBeLessThanOrEqual(128)
  })

  it("links the public legal pages a directory listing requires", () => {
    expect(manifest.interface).toMatchObject({
      supportURL: "https://aquilla.app/support",
      privacyPolicyURL: "https://aquilla.app/privacy",
      termsOfServiceURL: "https://aquilla.app/terms",
    })
  })
})

describe("MCP server", () => {
  it("targets the production sync host's MCP endpoint", () => {
    const servers = (JSON.parse(read(".mcp.json")) as { mcpServers: Record<string, { url: string }> }).mcpServers
    const apiHost = deploymentManifest.surfaces.sync.environments.production.apiHost
    expect(servers.aquilla.url).toBe(`https://${apiHost}/sync/api/v1/external/mcp`)
  })
})

describe("skills", () => {
  it("each has frontmatter whose name matches its folder and a description", () => {
    expect(skillDirs.length).toBeGreaterThan(0)
    for (const dir of skillDirs) {
      const body = read("skills", dir, "SKILL.md")
      const frontmatter = body.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? ""
      expect(frontmatter, dir).toContain(`name: ${dir}`)
      expect(frontmatter, dir).toMatch(/^description: .{40,}/m)
    }
  })

  it("only call tools the MCP server actually serves", () => {
    const served = new Set(MCP_TOOLS.map((tool) => tool.name))
    for (const dir of skillDirs) {
      const named = [...read("skills", dir, "SKILL.md").matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1])
      expect(named.length, dir).toBeGreaterThan(0)
      // Backticked snake_case words in a skill are tool names (fields are camelCase).
      for (const name of named) expect(served.has(name), `${dir} names unknown tool ${name}`).toBe(true)
    }
  })
})

describe("reviewable operations", () => {
  it("declares independent write tools and no arbitrary command executor", () => {
    expect(MCP_TOOLS.map(t => t.name)).toContain("prepare_create_project")
    expect(MCP_TOOLS.map(t => t.name)).not.toContain("describe_command")
    const prepare = MCP_TOOLS.find(t => t.name === "prepare_translations")!
    expect(prepare.inputSchema.properties).not.toHaveProperty("commands")
    for (const tool of MCP_TOOLS) {
      expect(tool.annotations.readOnlyHint).toBeTypeOf("boolean")
      expect(tool.annotations.destructiveHint).toBeTypeOf("boolean")
      expect(tool.annotations.openWorldHint).toBeTypeOf("boolean")
      expect(tool.securitySchemes).toEqual([{ type: "oauth2", scopes: ["act"] }])
    }
    expect(MCP_TOOLS.find(t => t.name === "discard_changeset")?.annotations.destructiveHint).toBe(true)
  })
})

it("packages exactly five positive and three negative review cases using declared tools", () => {
  const cases = manifest.extensions["com.openai"].review.test_cases
  expect(cases.positive).toHaveLength(5)
  expect(cases.negative).toHaveLength(3)
  const tools = new Set(MCP_TOOLS.map(t => t.name))
  for (const testCase of cases.positive) {
    for (const name of testCase.tools_triggered.split(", ")) expect(tools.has(name), name).toBe(true)
  }
})
