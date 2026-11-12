import { useEffect, useState } from "react"
import { getAiMeter, type AiMeterData } from "@/lib/billing/ai-meter"
import { onAiRefusal } from "@/lib/billing/ai-refusal"

/**
 * AQU-2068: the org's % meter. Plain useState + useEffect (AD-3). `undefined`
 * while loading, `null` when the read failed. A refusal from any AI call
 * flips it to 100% at once, so the meter never says "42%" next to an AI
 * action the server just refused. Bump `refreshKey` to re-read (e.g. after an
 * agent run settles).
 */
export function useAiMeter(jwt: string | null, orgId: number | null, refreshKey = 0): AiMeterData | null | undefined {
  const [result, setResult] = useState<{ key: string; data: AiMeterData | null } | null>(null)
  const key = `${jwt ?? ""}:${orgId ?? ""}`

  useEffect(() => {
    if (!jwt || orgId == null) return
    let cancelled = false
    getAiMeter(jwt, orgId)
      .then((data) => { if (!cancelled) setResult({ key, data }) })
      .catch(() => { if (!cancelled) setResult({ key, data: null }) })
    return () => { cancelled = true }
  }, [jwt, orgId, key, refreshKey])

  useEffect(() => onAiRefusal((refusal) => {
    setResult((current) => current?.key === key && current.data && current.data.mode === "metered"
      ? { key, data: { ...current.data, percentUsed: 100, resetsAt: refusal.resetsAt ?? current.data.resetsAt } }
      : current)
  }), [key])

  if (!jwt || orgId == null) return null
  return result?.key === key ? result.data : undefined
}
