import { useState } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { AdminSettingsSection } from "./AdminSettingsSection"
import { AdminCreditsSection } from "./AdminCreditsSection"
import { AdminBillingSection } from "./AdminBillingSection"

/**
 * Platform — editable admin surfaces grouped together (away from the
 * read-only oversight tabs): AI settings, AI-credit caps, and Field
 * Plan billing. A light sub-nav switches between them so the console's
 * top-level tab bar stays about "what's happening" vs. "what I configure".
 */
type Sub = "settings" | "credits" | "billing"

export function AdminPlatformSection({ jwt }: { jwt: string }) {
  const [sub, setSub] = useState<Sub>("settings")
  return (
    <div className="space-y-4">
      <Tabs value={sub} onValueChange={(v) => setSub(v as Sub)}>
        <TabsList>
          <TabsTrigger value="settings">AI settings</TabsTrigger>
          <TabsTrigger value="credits">AI credits</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
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
      </Tabs>
    </div>
  )
}
