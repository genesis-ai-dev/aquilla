#!/usr/bin/env node
// One-shot PostHog ops setup for import observability (AQU — mp3 import triage).
//
// Creates in project 401628 (us.posthog.com):
//   1. Funnel insight  — "import started" → "import succeeded", broken down by import_type
//   2. Trend insight   — "import failed" count, broken down by file_exts
//   3. Dashboard       — "Import health" holding both tiles
//   4. Alert           — fires when "import failed" exceeds 0 in a day
//
// Requires a *personal* API key (phx_…) with insight/dashboard/alert write scopes:
//   POSTHOG_PERSONAL_API_KEY=phx_… node scripts/posthog-ops-setup.mjs
//
// Safe to re-run: existing objects are found by name and left in place.

const HOST = "https://us.posthog.com"
const PROJECT_ID = 401628
const KEY = process.env.POSTHOG_PERSONAL_API_KEY

if (!KEY) {
  console.error("Set POSTHOG_PERSONAL_API_KEY (phx_…) — create one at https://us.posthog.com/settings/user-api-keys")
  process.exit(1)
}

const api = async (method, path, body) => {
  const res = await fetch(`${HOST}/api/projects/${PROJECT_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 500)}`)
  return json
}

const findByName = async (path, name, field = "name") => {
  const list = await api("GET", `${path}?search=${encodeURIComponent(name)}&limit=20`)
  return (list.results ?? []).find((r) => r[field] === name || r.derived_name === name)
}

// 0. Enable session replay at the project level — confirmed OFF via /decide
// (this, not the client init, is why aquilla.app has zero recordings).
const settings = await api("GET", "/")
if (!settings.session_recording_opt_in) {
  await api("PATCH", "/", { session_recording_opt_in: true })
  console.log("enabled session replay (session_recording_opt_in)")
} else console.log("session replay already enabled")

// 1. Funnel: import started → import succeeded, by import_type
const funnelName = "Import funnel (started → succeeded)"
let funnel = await findByName("/insights/", funnelName)
if (!funnel) {
  funnel = await api("POST", "/insights/", {
    name: funnelName,
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "FunnelsQuery",
        series: [
          { kind: "EventsNode", event: "import started", name: "import started" },
          { kind: "EventsNode", event: "import succeeded", name: "import succeeded" },
        ],
        funnelsFilter: { funnelWindowInterval: 1, funnelWindowIntervalUnit: "hour" },
        breakdownFilter: { breakdown: "import_type", breakdown_type: "event" },
        dateRange: { date_from: "-30d" },
      },
    },
  })
  console.log(`created funnel insight ${funnel.short_id}`)
} else console.log(`funnel insight exists: ${funnel.short_id}`)

// 2. Trend: import failed by file_exts
const trendName = "Import failures by file type"
let trend = await findByName("/insights/", trendName)
if (!trend) {
  trend = await api("POST", "/insights/", {
    name: trendName,
    query: {
      kind: "InsightVizNode",
      source: {
        kind: "TrendsQuery",
        series: [{ kind: "EventsNode", event: "import failed", name: "import failed", math: "total" }],
        breakdownFilter: { breakdown: "file_exts", breakdown_type: "event" },
        interval: "day",
        dateRange: { date_from: "-30d" },
      },
    },
  })
  console.log(`created trend insight ${trend.short_id}`)
} else console.log(`trend insight exists: ${trend.short_id}`)

// 3. Dashboard with both tiles
const dashName = "Import health"
let dash = await findByName("/dashboards/", dashName)
if (!dash) {
  dash = await api("POST", "/dashboards/", { name: dashName, description: "Import funnel + failure breakdown (mp3 triage — see IMPORT_FAILED events and PostHog Logs for worker 4xx/5xx)" })
  console.log(`created dashboard ${dash.id}`)
} else console.log(`dashboard exists: ${dash.id}`)
for (const insight of [funnel, trend]) {
  const dashboardIds = insight.dashboards ?? []
  if (!dashboardIds.includes(dash.id)) {
    await api("PATCH", `/insights/${insight.id}/`, { dashboards: [...dashboardIds, dash.id] })
    console.log(`added insight ${insight.short_id} to dashboard`)
  }
}

// 4. Alert: any import failure in a day
const alertName = "Import failures > 0 (daily)"
const alerts = await api("GET", "/alerts/")
if (!(alerts.results ?? []).find((a) => a.name === alertName)) {
  await api("POST", "/alerts/", {
    name: alertName,
    insight: trend.id,
    enabled: true,
    calculation_interval: "daily",
    condition: { type: "absolute_value" },
    threshold: { configuration: { type: "absolute", bounds: { upper: 0 } } },
    config: { type: "TrendsAlertConfig", series_index: 0 },
    subscribed_users: [],
  })
  console.log("created alert")
} else console.log("alert exists")

console.log(`\nDashboard: ${HOST}/project/${PROJECT_ID}/dashboard/${dash.id}`)
