import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
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
  const launchOptions = process.env.WORKERS_CI === "1"
    ? await (async () => {
        const chromiumModule = await import("@sparticuz/chromium")
        const { default: serverlessChromium, inflate, setupLambdaEnvironment } = chromiumModule

        // Cloudflare Workers Builds runs on Ubuntu, so @sparticuz/chromium
        // does not identify it as an Amazon Linux environment and therefore
        // does not unpack or expose its bundled browser libraries. The
        // headless binary still needs those libraries (notably NSS) to start.
        // Prepare the public package bundle explicitly instead of relying on
        // provider-specific environment detection.
        const chromiumEntry = fileURLToPath(import.meta.resolve("@sparticuz/chromium"))
        const chromiumPackageRoot = resolve(dirname(chromiumEntry), "..")
        await inflate(resolve(chromiumPackageRoot, "bin", "al2023.tar.br"))
        setupLambdaEnvironment(resolve(tmpdir(), "al2023", "lib"))

        return {
          args: serverlessChromium.args,
          executablePath: await serverlessChromium.executablePath(),
          headless: true as const,
        }
      })()
    : { headless: true as const }
  browser = await chromium.launch(launchOptions)
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
