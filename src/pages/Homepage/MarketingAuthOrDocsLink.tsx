import { useEffect, useState } from "react"
import { hasAuthHintCookie, loadActiveSession } from "@/lib/frontier/session-store"

/**
 * Presence check for marketing CTAs. Always starts false so prerendered /
 * edge-cached markup is identical for every visitor; after mount it flips
 * when a stored session (or auth-hint cookie) is found.
 */
export function useMarketingSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (hasAuthHintCookie()) {
      setSignedIn(true)
      return
    }
    loadActiveSession()
      .then((session) => {
        if (!cancelled && session) setSignedIn(true)
      })
      .catch(() => {
        // No IndexedDB — treat as signed out.
      })
    return () => {
      cancelled = true
    }
  }, [])

  return signedIn
}

type MarketingAuthOrDocsLinkProps = {
  docsUrl: string
  className?: string
  loginHref?: string
}

/** Ghost CTA: "Sign in" for visitors, "Docs" once a session is present. */
export function MarketingAuthOrDocsLink({
  docsUrl,
  className,
  loginHref = "/login",
}: MarketingAuthOrDocsLinkProps) {
  const signedIn = useMarketingSignedIn()
  if (signedIn) {
    return (
      <a href={docsUrl} className={className}>
        Docs
      </a>
    )
  }
  return (
    <a href={loginHref} className={className}>
      Sign in
    </a>
  )
}
