import { useEffect, useState } from "react"
import { getConnectionActivity } from "@/lib/sync/connection-activity"

export function useConnectionActivity(open: boolean) {
  const [activity, setActivity] = useState(getConnectionActivity)
  useEffect(() => {
    if (!open) return
    const update = () => setActivity(getConnectionActivity())
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [open])
  return activity
}
