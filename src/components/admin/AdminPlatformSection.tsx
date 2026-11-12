import { useSearchParams } from "react-router-dom"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { AdminSettingsSection } from "./AdminSettingsSection"
import { AdminCreditsSection } from "./AdminCreditsSection"
import { AdminBillingSection } from "./AdminBillingSection"
import { AdminFeedbackRoutesSection } from "./AdminFeedbackRoutesSection"

/**
 * Platform — editable admin surfaces grouped together (away from the
 * read-only oversight tabs): AI settings, AI-credit caps, Field
 * Plan billing, and feedback email routing. A light sub-nav switches between them so the console's
 * top-level tab bar stays about "what's happening" vs. "what I configure".
 */
type Sub = "settings" | "credits" | "billing" | "feedback"
const SUBS: readonly Sub[] = ["settings", "credits", "billing", "feedback"]

export function AdminPlatformSection({ jwt }: { jwt: string }) {
  // `?platform=` keeps the sub-tab across reloads and in shared links; changing
  // it keeps the console tab and drops the billing list's search keys.
  const [params, setParams] = useSearchParams()
  const subParam = params.get("platform")
  const sub: Sub = SUBS.includes(subParam as Sub) ? (subParam as Sub) : "settings"
  return (
    <div className="space-y-4">
      <Tabs
        value={sub}
        onValueChange={(v) => {
          const next = new URLSearchParams()
          const tab = params.get("tab")
          if (tab) next.set("tab", tab)
          if (v !== "settings") next.set("platform", String(v))
          setParams(next)
        }}
      >
        <TabsList>
          <TabsTrigger value="settings">AI settings</TabsTrigger>
          <TabsTrigger value="credits">AI credits</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="feedback">Feedback routing</TabsTrigger>
        </TabsList>
        <TabsContent value="settings" className="mt-4">
          <AdminSettingsSection jwt={jwt} />
        </TabsContent>
        <TabsContent value="credits" className="mt-4">
          <AdminCreditsSection jwt={jwt} />
        </TabsContent>
        <TabsContent value="billing" className="mt-4">
          <AdminBillingSection jwt={jwt} />
        </TabsContent>
        <TabsContent value="feedback" className="mt-4">
          <AdminFeedbackRoutesSection jwt={jwt} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
