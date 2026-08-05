// The browser's connectivity signal as React state. Extracted from
// useProjectSettings (2026-08-05) so features that must BLOCK an action while
// offline (the recording modal) share one implementation instead of the six
// copy-pasted navigator.onLine blocks that grew around the app — de-duping
// the other five (OfflineBanner, the two auth forms, useFileSync, useLiveness)
// is a listed follow-up.
//
// navigator.onLine is a conservative signal: `false` reliably means "no
// network interface", while `true` only means "an interface exists" — actual
// reachability can still fail. Callers should treat offline as a hard block
// and online as merely "worth trying".

import { useEffect, useState } from "react"

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [])
  return online
}
