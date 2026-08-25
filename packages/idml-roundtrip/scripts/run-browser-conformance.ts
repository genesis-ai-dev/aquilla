import type { AddressInfo } from "node:net"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "@playwright/test"
import { createServer } from "vite"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = resolve(packageRoot, "../..")
const server = await createServer({
  root: packageRoot,
  configFile: false,
  appType: "spa",
  logLevel: "error",
  server: {
    host: "127.0.0.1",
    port: 0,
    strictPort: false,
    fs: { allow: [repositoryRoot] },
  },
})

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  await server.listen()
  const address = server.httpServer?.address() as AddressInfo | null | undefined
  if (!address) throw new Error("Vite did not expose a browser-conformance address")
  const baseUrl = `http://127.0.0.1:${address.port}`
  const moduleUrl = `${baseUrl}/src/conformance/browser-runner.ts`
  const moduleResponse = await fetch(moduleUrl)
  if (!moduleResponse.ok) {
    throw new Error(
      `Vite could not transform the browser runner (${moduleResponse.status}): ${
        await moduleResponse.text()
      }`,
    )
  }
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(`${baseUrl}/fixtures/browser.html`)
  const report = await page.evaluate(async () => {
    const promise = (
      window as typeof window & {
        __idmlCorpusConformance?: Promise<unknown>
      }
    ).__idmlCorpusConformance
    if (!promise) throw new Error("Browser conformance module did not initialize")
    return promise
  })
  process.stdout.write(`Chromium IDML conformance passed: ${JSON.stringify(report)}\n`)
} finally {
  await browser?.close()
  await server.close()
}
