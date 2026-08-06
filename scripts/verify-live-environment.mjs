import { lookup as dnsLookup } from "node:dns/promises"
import { pathToFileURL } from "node:url"

const ENVIRONMENTS = {
  production: {
    apiHost: "api.aquilla.app",
    appOrigin: "https://aquilla.app",
    forbiddenBundleHosts: ["api.dev.aquilla.app"],
  },
  development: {
    apiHost: "api.dev.aquilla.app",
    appOrigin: "https://dev.aquilla.app",
    // Nothing left to forbid now that staging is gone. `api.aquilla.app`
    // cannot go on this list: it is the compiled-in default in auth.ts,
    // sync-token.ts, sync-worker-host.ts and completion-service.ts, so it
    // appears in every bundle regardless of the VITE_* targets.
    forbiddenBundleHosts: [],
  },
}

const VALID_SURFACES = new Set(["all", "auth", "sync", "spa"])

// The bare origin serves the prerendered marketing homepage (worker/index.ts),
// whose small JS graph never imports the sync client or the chat completion
// service — crawling it can't prove the SPA targets the right environment
// (AQU-779). Any non-marketing path falls through to the assets binding's
// single-page-application fallback and serves the real SPA shell; /app is a
// stable route in the App.tsx route table.
const SPA_SHELL_PATH = "/app"

// Cookie-independent static marketing pages mapped by worker/index.ts
// STATIC_PAGES. A deploy that publishes the Worker but drops these HTML entries
// from the asset bundle makes each path miss env.ASSETS.fetch() and fall
// through the single-page-application not-found handler to the SPA index shell
// — a silent, partner-facing 404 (the homepage footer links straight here).
// This is exactly the AQU-798 recurrence.
//
// The tell is the served document's og:url: each case-study page hardcodes its
// own canonical og:url, while the index shell carries the bare-origin og:url
// (%BRAND_OG_URL% → https://aquilla.app/). If a path served the shell instead
// of its dedicated document, og:url won't match. The expected og:url is the
// canonical production URL baked into the source HTML, so it's identical across
// environments (production/staging/dev/preview all serve the same asset bundle).
const STATIC_MARKETING_PAGES = [
  { path: "/case-studies/biblica", ogUrl: "https://aquilla.app/case-studies/biblica" },
  { path: "/case-studies/come-and-see", ogUrl: "https://aquilla.app/case-studies/come-and-see" },
]

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function assertResponse(response, expectedStatus, description) {
  if (response.status !== expectedStatus) {
    throw new Error(`${description} returned HTTP ${response.status}; expected ${expectedStatus}`)
  }
}

async function requestWithRetry(url, init, verify, options) {
  const {
    fetchImpl,
    attempts,
    retryDelayMs,
    log,
  } = options
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, init)
      await verify(response)
      return
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        log(`[verify-live] retrying ${url} (${attempt}/${attempts})`)
        await delay(retryDelayMs)
      }
    }
  }

  throw lastError
}

async function operationWithRetry(description, operation, options) {
  let lastError

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      await operation()
      return
    } catch (error) {
      lastError = error
      if (attempt < options.attempts) {
        options.log(`[verify-live] retrying ${description} (${attempt}/${options.attempts})`)
        await delay(options.retryDelayMs)
      }
    }
  }

  throw lastError
}

async function verifyApiDns(config, options) {
  const addresses = await options.lookup(config.apiHost, { all: true })
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`${config.apiHost} has no DNS addresses`)
  }
  options.log(
    `[verify-live] DNS ${config.apiHost} -> ${addresses.map(({ address }) => address).join(", ")}`,
  )
}

async function verifyAuth(config, options) {
  const identityUrl = `https://${config.apiHost}/identity/api/v2/health`
  await requestWithRetry(
    identityUrl,
    { headers: { Accept: "application/json" } },
    async (response) => {
      assertResponse(response, 200, "identity health")
      const body = await response.json()
      if (body?.ok !== true || body?.name !== "aquilla-identity") {
        throw new Error(`identity health returned an unexpected body: ${JSON.stringify(body)}`)
      }
    },
    options,
  )

  const chatUrl = `https://${config.apiHost}/chat/api/v1/chat/completions`
  await requestWithRetry(
    chatUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "default", messages: [] }),
    },
    async (response) => {
      assertResponse(response, 401, "chat auth guard")
      const body = await response.json()
      if (body?.error !== "Authorization header required") {
        throw new Error(`chat auth guard returned an unexpected body: ${JSON.stringify(body)}`)
      }
    },
    options,
  )

  options.log(`[verify-live] identity and chat routes are healthy on ${config.apiHost}`)
}

async function verifySync(config, options) {
  const syncUrl = `https://${config.apiHost}/sync/events`
  await requestWithRetry(
    syncUrl,
    { headers: { Accept: "text/plain" } },
    async (response) => {
      assertResponse(response, 401, "sync auth guard")
      const body = (await response.text()).trim()
      if (body !== "missing Authorization header") {
        throw new Error(`sync auth guard returned an unexpected body: ${JSON.stringify(body)}`)
      }
    },
    options,
  )

  options.log(`[verify-live] sync route is healthy on ${config.apiHost}`)
}

function scriptSources(html) {
  return [...html.matchAll(/<script[^>]+src=["']([^"']+\.js)["']/gi)].map((match) => match[1])
}

function javascriptReferences(source) {
  return [...source.matchAll(/["'`]([^"'`]+\.js)["'`]/g)].map((match) => match[1])
}

async function fetchJavascriptGraph(appOrigin, entrySources, options) {
  const pending = entrySources.map((source) => new URL(source, appOrigin).href)
  const visited = new Set()
  const bodies = []

  while (pending.length > 0) {
    const batch = pending.splice(0, 12).filter((url) => !visited.has(url))
    if (batch.length === 0) continue
    batch.forEach((url) => visited.add(url))

    const results = await Promise.all(batch.map(async (url) => {
      const parsed = new URL(url)
      if (parsed.origin !== appOrigin || !parsed.pathname.endsWith(".js")) {
        throw new Error(`refusing to inspect unexpected script URL ${url}`)
      }
      const response = await options.fetchImpl(url)
      assertResponse(response, 200, `SPA asset ${parsed.pathname}`)
      return { url, source: await response.text() }
    }))

    for (const { url, source } of results) {
      bodies.push(source)
      for (const reference of javascriptReferences(source)) {
        // Vite's preload dependency map stores root-relative asset paths
        // without a leading slash ("assets/chunk.js"), while ESM imports use
        // normal relative paths ("./chunk.js"). Resolve both exactly as the
        // browser does instead of accidentally producing /assets/assets/….
        const referencedUrl = reference.startsWith("assets/")
          ? new URL(`/${reference}`, appOrigin)
          : new URL(reference, url)
        if (referencedUrl.origin === appOrigin && referencedUrl.pathname.endsWith(".js")) {
          pending.push(referencedUrl.href)
        }
      }
    }

    if (visited.size > 300) {
      throw new Error("SPA references more than 300 JavaScript assets; refusing an unbounded crawl")
    }
  }

  return bodies.join("\n")
}

async function verifySpa(config, options) {
  const appUrl = new URL(SPA_SHELL_PATH, config.appOrigin).href
  const response = await options.fetchImpl(appUrl, {
    headers: { Accept: "text/html" },
  })
  assertResponse(response, 200, "SPA entrypoint")
  const html = await response.text()
  const entries = scriptSources(html)
  if (entries.length === 0) {
    throw new Error("SPA entrypoint contains no JavaScript module")
  }

  const bundle = await fetchJavascriptGraph(config.appOrigin, entries, options)
  const expectedValues = [
    `https://${config.apiHost}/identity`,
    `${config.apiHost}/sync`,
    `https://${config.apiHost}/chat`,
  ]
  const missing = expectedValues.filter((value) => !bundle.includes(value))
  if (missing.length > 0) {
    throw new Error(`SPA bundle is missing environment targets: ${missing.join(", ")}`)
  }

  const forbidden = config.forbiddenBundleHosts.filter((host) => bundle.includes(host))
  if (forbidden.length > 0) {
    throw new Error(`SPA bundle contains cross-environment hosts: ${forbidden.join(", ")}`)
  }

  options.log(`[verify-live] SPA at ${appUrl} targets only the expected live environment`)
}

// Reads a <meta property="…" content="…"> value. The marketing HTML is
// hand-authored with a stable attribute order (property before content), and
// prerender-marketing only injects body content, so a targeted regex is safe.
function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = html.match(
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']*)["']`, "i"),
  )
  return match?.[1]
}

// AQU-798 regression guard: prove the case-study static pages resolve to their
// dedicated documents rather than the SPA index-shell fallback. Runs post-deploy
// as part of the spa surface, so a bundle that silently omits the case-study
// HTML fails the deploy instead of shipping a partner-facing 404.
async function verifyStaticPages(config, options) {
  for (const page of STATIC_MARKETING_PAGES) {
    const pageUrl = new URL(page.path, config.appOrigin).href
    await requestWithRetry(
      pageUrl,
      { headers: { Accept: "text/html" } },
      async (response) => {
        assertResponse(response, 200, `static page ${page.path}`)
        const html = await response.text()
        const ogUrl = metaContent(html, "og:url")
        if (ogUrl !== page.ogUrl) {
          throw new Error(
            `${page.path} served the wrong document (og:url ${JSON.stringify(ogUrl)}; `
            + `expected ${JSON.stringify(page.ogUrl)}). The case-study HTML is likely missing `
            + `from the deployed asset bundle, so the path fell back to the SPA index shell.`,
          )
        }
      },
      options,
    )
  }
  options.log(`[verify-live] static marketing pages resolve to their dedicated documents on ${config.appOrigin}`)
}

function withAppOrigin(config, appOrigin, surface) {
  if (appOrigin === undefined) return config
  if (surface !== "spa") {
    throw new Error("--app-origin may only be used with --surface=spa")
  }

  let parsed
  try {
    parsed = new URL(appOrigin)
  } catch {
    throw new Error(`invalid app origin ${JSON.stringify(appOrigin)}`)
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`invalid app origin ${JSON.stringify(appOrigin)}; expected an HTTPS origin without a path`)
  }
  return { ...config, appOrigin: parsed.origin }
}

export async function verifyLiveEnvironment(environment, {
  surface = "all",
  appOrigin,
  fetchImpl = fetch,
  lookup = dnsLookup,
  attempts = 5,
  retryDelayMs = 1_000,
  log = console.log,
} = {}) {
  const environmentConfig = ENVIRONMENTS[environment]
  if (!environmentConfig) {
    throw new Error(`unknown environment ${JSON.stringify(environment)}; expected production or development`)
  }
  if (!VALID_SURFACES.has(surface)) {
    throw new Error(`unknown surface ${JSON.stringify(surface)}; expected all, auth, sync, or spa`)
  }
  const config = withAppOrigin(environmentConfig, appOrigin, surface)

  const options = { fetchImpl, lookup, attempts, retryDelayMs, log }
  if (surface === "all" || surface === "auth" || surface === "sync") {
    await verifyApiDns(config, options)
  }
  if (surface === "all" || surface === "auth") await verifyAuth(config, options)
  if (surface === "all" || surface === "sync") await verifySync(config, options)
  if (surface === "all" || surface === "spa") {
    await operationWithRetry(config.appOrigin, () => verifySpa(config, options), options)
    await verifyStaticPages(config, options)
  }

  log(`[verify-live] ${environment}/${surface} verification passed`)
}

function parseCliArgs(argv) {
  const environment = argv[0]
  const surfaceArg = argv.find((arg) => arg.startsWith("--surface="))
  const appOriginArg = argv.find((arg) => arg.startsWith("--app-origin="))
  return {
    environment,
    surface: surfaceArg?.slice("--surface=".length) || "all",
    appOrigin: appOriginArg?.slice("--app-origin=".length),
  }
}

const isEntrypoint = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntrypoint) {
  const { environment, surface, appOrigin } = parseCliArgs(process.argv.slice(2))
  verifyLiveEnvironment(environment, { surface, appOrigin }).catch((error) => {
    console.error(`[verify-live] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
