// Billing app — Phase 3c "Coming Soon" scaffold.
//
// Per 04-features/billing-and-tiers.md the full billing surface is `later`
// (out of v1 scope). This app exists so the apps/<slug>/ topology is
// uniform — every discrete task gets its own deployable Worker — and so
// the route is reserved at `/billing/*` for the eventual port.
//
// Once the real flows land they'll route under here:
//   /              — current plan + usage summary
//   /upgrade       — Stripe Checkout handoff
//   /history       — past invoices
//   /webhook       — Stripe webhook receiver (server-side; not a page)

import { BrowserRouter, Routes, Route } from "react-router-dom"
import { Card, CardContent, CardHeader, CardTitle } from "@aquilla/ui"

export function App() {
  return (
    <BrowserRouter basename="/billing">
      <Routes>
        <Route path="/*" element={<ComingSoonPage />} />
      </Routes>
    </BrowserRouter>
  )
}

function ComingSoonPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-xl items-center px-6 py-12">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Billing &mdash; coming soon</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Aquilla is in early access and there&rsquo;s nothing to pay for yet.
            Plans, usage tracking, and invoice history will land here as the
            billing surface comes online.
          </p>
          <p>
            See the spec at <code>specs/04-features/billing-and-tiers.md</code>{" "}
            for the planned flows.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
