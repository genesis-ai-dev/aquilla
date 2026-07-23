export interface AgentSandboxConnection {
  url: string
  key: string
}

/** Read one simple KEY=value entry from a Wrangler .dev.vars file. */
export function readDevVar(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = source.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.*?)\\s*$`, "m"))
  if (!match) return ""
  return match[1].replace(/^(["'])(.*)\1$/, "$2").trim()
}

/**
 * Resolve an explicitly configured sandbox endpoint for Docker-free local
 * development. Process variables win as a pair; auth-worker/.dev.vars is the
 * persistent fallback. A half-configured endpoint fails fast instead of
 * silently mixing credentials from two configuration sources or running the
 * agent without code execution.
 */
export function resolveConfiguredAgentSandbox(
  processEnv: Record<string, string | undefined>,
  devVarsSource = "",
): AgentSandboxConnection | null {
  const processUrl = (processEnv.AGENT_SANDBOX_URL ?? "").trim()
  const processKey = (processEnv.AGENT_SANDBOX_KEY ?? "").trim()
  const processConfigured = processUrl !== "" || processKey !== ""
  const url = processConfigured
    ? processUrl
    : readDevVar(devVarsSource, "AGENT_SANDBOX_URL").trim()
  const key = processConfigured
    ? processKey
    : readDevVar(devVarsSource, "AGENT_SANDBOX_KEY").trim()

  if (!url && !key) return null
  if (!url || !key) {
    throw new Error(
      "AGENT_SANDBOX_URL and AGENT_SANDBOX_KEY must be configured together",
    )
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("AGENT_SANDBOX_URL must be a valid absolute URL")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("AGENT_SANDBOX_URL must use http or https")
  }

  return { url: url.replace(/\/$/, ""), key }
}
