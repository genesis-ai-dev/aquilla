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
const title = `${label}\nbuild: ${BRANCH}@${SHA}`

// Routes that render a full-height left rail (via <AppShell/>). There the version
// lives in-flow at the rail's foot (<VersionTag/>), so the floating badge must
// stand down or it duplicates that tag and paints over the rail's bottom controls
// (the account switcher, Settings, the voice library, …).
//   /                            — org overview          (OrgHome)
//   /projects, /projects/:id     — org project list / detail
//   /teams, /teams/:groupId      — org team list / detail
//   /members                     — org members
//   /project/:id                 — workspace
//   /project/:id/file/:fileId    — workspace with a file open
//   /project/:id/voice           — Voice Studio
// The other /project/* pages (rules, comments, settings) and /settings are centred
// and leave the corner free, so they keep the floating badge.
function hasLeftRail(pathname: string): boolean {
  const segs = pathname.split("/").filter(Boolean)
  if (segs.length === 0) return true // "/" — org overview
  if (segs[0] === "projects" || segs[0] === "teams" || segs[0] === "members") return true
  if (segs[0] === "project" && segs.length >= 2) {
    return segs.length === 2 || segs[2] === "file" || segs[2] === "voice"
  }
  return false
}

/**
 * In-flow version line for the bottom of a left rail. `mt-auto` pins it to the
 * foot of a flex column; it never overlaps content because it occupies layout.
 */
export function VersionTag() {
  return (
    <div
      title={title}
      className="mt-auto shrink-0 px-3 py-1.5 font-mono text-[10px] leading-none text-muted-foreground/40 select-none"
    >
      {label}
    </div>
  )
}

/**
 * Floating badge for screens without a left rail (dashboard, onboarding, join,
 * settings, centred project pages). pointer-events-none so it can never block a
 * control underneath it.
 */
export function VersionBadge() {
  const { pathname } = useLocation()
  if (hasLeftRail(pathname)) return null

  return (
    <div
      title={title}
      className="neu-flat fixed bottom-3 left-3 z-30 rounded-full px-3 py-1.5 font-mono text-[11px] leading-none text-muted-foreground/70 select-none pointer-events-none"
    >
      {label}
    </div>
  )
}
