import { useLocation } from "react-router-dom"

declare const __APP_VERSION__: string
declare const __APP_BRANCH__: string
declare const __APP_SHA__: string

const VERSION = __APP_VERSION__
const BRANCH = __APP_BRANCH__
const SHA = __APP_SHA__

// Show branch unless we're on the production line — there it's noise.
const isProd = BRANCH === "main" || BRANCH === "production"
const label = isProd ? `v${VERSION} · ${SHA}` : `v${VERSION} · ${BRANCH} · ${SHA}`

export function VersionBadge() {
  const { pathname } = useLocation()
  // Inside a project the workspace owns the bottom-left corner (cell rail,
  // status chips). Drop to a barely-visible tag there; outside, lift it to
  // a small info chip so it's noticeable on onboarding/dashboard.
  const insideProject = pathname.startsWith("/project/")
  const title = `${label}\nbuild: ${BRANCH}@${SHA}`

  if (insideProject) {
    return (
      <div
        title={title}
        className="fixed bottom-1 left-2 z-30 font-mono text-[10px] leading-none text-muted-foreground/40 select-none pointer-events-none"
      >
        {label}
      </div>
    )
  }

  return (
    <div
      title={title}
      className="neu-flat fixed bottom-3 left-3 z-30 font-mono text-[11px] leading-none text-muted-foreground/70 rounded-full px-3 py-1.5 select-none"
    >
      {label}
    </div>
  )
}
