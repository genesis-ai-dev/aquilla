// @vitest-environment node
/**
 * AQU-1937: the ESLint rule that reserves the Smart Extensions identity color
 * (eslint.config.js) flags the token anywhere except ExtensionFrame /
 * ExtensionMarker.
 */

import path from "node:path"
import { fileURLToPath } from "node:url"
import { ESLint } from "eslint"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const CODE = 'export const cls = "border-[var(--extension-accent)]"\nexport const tpl = `bg-[var(--extension-accent-subtle)]`\n'

async function ruleHits(file: string): Promise<number> {
  const eslint = new ESLint({ cwd: ROOT })
  const [result] = await eslint.lintText(CODE, { filePath: path.join(ROOT, file) })
  return result.messages.filter((m) => m.ruleId === "no-restricted-syntax" && /extension-accent/.test(m.message)).length
}

describe("reserved --extension-accent lint rule", () => {
  it("flags the token in ordinary app code", async () => {
    expect(await ruleHits("src/components/SomethingElse.tsx")).toBe(2)
    expect(await ruleHits("shared/tools/whatever.ts")).toBe(2)
  }, 60_000)

  it("allows it in the host-drawn frame and marker", async () => {
    expect(await ruleHits("src/components/tools/ExtensionFrame.tsx")).toBe(0)
    expect(await ruleHits("src/components/tools/ExtensionMarker.tsx")).toBe(0)
  }, 60_000)
})
