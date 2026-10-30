import { useEffect } from "react"
import { useAccounts } from "@/hooks/useAccounts"
// Registers every preference that follows the person, so the first read of a
// person's record can give them (or take from them) all of them at once.
import "@/lib/prefs/person-pref-list"
import { setPersonPrefsSession } from "@/lib/prefs/person-prefs"

/**
 * Invisible mount (AQU-2264): hands the signed-in session to the preferences
 * that follow the person, so they read the person's record on sign-in and
 * send what this device has queued. Signed out, it hands over nothing, and
 * every such preference stays on this device as it always has.
 */
export function PersonPrefsSyncMount() {
  const { active } = useAccounts()
  const username = active?.username ?? null
  const jwt = active?.jwt ?? null

  useEffect(() => {
    setPersonPrefsSession(username && jwt ? { username, jwt } : null)
  }, [username, jwt])

  return null
}
