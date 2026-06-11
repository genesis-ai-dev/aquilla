import { Link } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAnalyticsConsent } from "@/hooks/useAnalyticsConsent"

const EFFECTIVE_DATE = "June 11, 2026"
const CONTACT_EMAIL = "privacy@frontierrnd.com"

export function PrivacyPolicy() {
  const { enabled, setEnabled } = useAnalyticsConsent()

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-2xl px-4 py-12">
        <Link to="/">
          <Button variant="ghost" size="sm" className="mb-8 -ml-2 gap-1.5 text-muted-foreground">
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
        </Link>

        <h1 className="text-3xl font-bold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Effective {EFFECTIVE_DATE}
        </p>

        <div className="mt-10 space-y-10 text-sm leading-relaxed text-foreground/90">
          {/* ── Intro ── */}
          <section>
            <p>
              Aquilla is operated by Frontier R&D Inc., a company based in Canada
              and the United States (&ldquo;we&rdquo;, &ldquo;us&rdquo;). This
              policy explains what data we collect, why, and how you can control it.
            </p>
            <p className="mt-3">
              Aquilla is a free service. We collect the data needed to operate the
              app, provide support, and improve our tools and services for the
              benefit of the whole community. We do not sell your personal data to
              advertisers or any third party.
            </p>
          </section>

          {/* ── What we collect ── */}
          <section>
            <h2 className="text-lg font-semibold">What we collect</h2>
            <div className="mt-3 space-y-4">
              <div>
                <h3 className="font-medium">Account data</h3>
                <p className="mt-1 text-muted-foreground">
                  When you create an account we store your email address, display
                  name, and hashed password. This is necessary to authenticate you
                  and let collaborators identify you in shared projects.
                </p>
              </div>

              <div>
                <h3 className="font-medium">Project data</h3>
                <p className="mt-1 text-muted-foreground">
                  Translation files, comments, terminology, audio recordings, and
                  project settings you create are stored on our servers to provide
                  the service. We may access project data to provide support,
                  troubleshoot issues, and improve our tools and services. We may
                  also use aggregated or de-identified project data to improve AI
                  models and features that benefit all users.
                </p>
              </div>

              <div>
                <h3 className="font-medium">Analytics</h3>
                <p className="mt-1 text-muted-foreground">
                  We use{" "}
                  <a
                    href="https://posthog.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2"
                  >
                    PostHog
                  </a>{" "}
                  for product analytics. Analytics is{" "}
                  <strong>enabled by default</strong> and is accepted during
                  onboarding. We rely on analytics to understand how features are
                  used, diagnose problems, and provide effective support to the
                  organisations we work with. You can opt out at any time in
                  Settings.
                </p>
              </div>

              <div>
                <h3 className="font-medium">Session recording</h3>
                <p className="mt-1 text-muted-foreground">
                  When analytics is enabled, we may record your browsing session
                  using PostHog Session Replay. Session recordings capture page
                  navigation, clicks, scrolls, and on-screen content to help us
                  diagnose bugs and understand the issues you encounter. Password
                  fields and email inputs are masked. Other on-screen content,
                  including translation text, may be visible in recordings so that
                  our team can understand the nature of reported problems. Session
                  recordings are automatically deleted after 30 days.
                </p>
              </div>

              <div>
                <h3 className="font-medium">AI features</h3>
                <p className="mt-1 text-muted-foreground">
                  When you use AI-powered features (such as AI-assisted translation,
                  checks, or suggestions), your project data may be sent to
                  third-party AI providers via API. We require that AI providers be
                  used via API tiers that exclude customer data from model training.
                  See the Third-party processors section below for details.
                </p>
              </div>

              <div>
                <h3 className="font-medium">Cookies &amp; local storage</h3>
                <p className="mt-1 text-muted-foreground">
                  We use a first-party authentication cookie (<code>aq_hint</code>)
                  to keep you signed in. PostHog stores a device identifier in
                  localStorage and a first-party cookie to link sessions. We do not
                  use third-party advertising or tracking cookies.
                </p>
              </div>
            </div>
          </section>

          {/* ── What we don't do ── */}
          <section>
            <h2 className="text-lg font-semibold">What we don&rsquo;t do</h2>
            <ul className="mt-3 list-disc pl-5 space-y-1 text-muted-foreground">
              <li>We do not sell personal data to advertisers or any third party.</li>
              <li>We do not use third-party advertising or tracking cookies.</li>
              <li>
                We do not permit our AI providers to train on your data — all AI
                features use API tiers that contractually exclude training.
              </li>
            </ul>
          </section>

          {/* ── Your choices ── */}
          <section>
            <h2 className="text-lg font-semibold">Your choices</h2>
            <div className="mt-3 space-y-3 text-muted-foreground">
              <p>
                <strong className="text-foreground/90">Analytics opt-out:</strong>{" "}
                You can disable analytics at any time in Settings. When you opt out,
                we stop collecting analytics events and session recordings
                immediately.
              </p>
              <p>
                <strong className="text-foreground/90">Account deletion:</strong>{" "}
                Email{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-2">
                  {CONTACT_EMAIL}
                </a>{" "}
                to request deletion of your account and all associated data.
              </p>
              <p>
                <strong className="text-foreground/90">Data export:</strong> You can
                export your project data at any time using the Export feature in
                Aquilla.
              </p>
            </div>

            <div className="mt-4 flex items-center gap-3 rounded-lg border bg-card p-4">
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">
                  Analytics is currently{" "}
                  <strong>{enabled ? "enabled" : "disabled"}</strong>
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {enabled
                    ? "Usage events and session recordings are being collected."
                    : "No analytics data is being collected."}
                </p>
              </div>
              <Button
                variant={enabled ? "outline" : "default"}
                size="sm"
                onClick={() => setEnabled(!enabled)}
              >
                {enabled ? "Opt out" : "Opt in"}
              </Button>
            </div>
          </section>

          {/* ── Third-party processors ── */}
          <section>
            <h2 className="text-lg font-semibold">Third-party data processors</h2>
            <p className="mt-3 text-muted-foreground">
              We use the following third-party services to operate Aquilla. Your
              data may be processed in the locations listed below.
            </p>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Provider</th>
                    <th className="pb-2 pr-4 font-medium">Purpose</th>
                    <th className="pb-2 font-medium">Location</th>
                  </tr>
                </thead>
                <tbody className="text-muted-foreground">
                  <tr className="border-b">
                    <td className="py-2 pr-4">Cloudflare</td>
                    <td className="py-2 pr-4">Hosting, CDN, edge compute, database, email routing</td>
                    <td className="py-2">Global (edge network)</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4">PostHog</td>
                    <td className="py-2 pr-4">Product analytics, session replay</td>
                    <td className="py-2">US</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4">Neon</td>
                    <td className="py-2 pr-4">PostgreSQL database</td>
                    <td className="py-2">US</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4">OpenRouter</td>
                    <td className="py-2 pr-4">AI model routing and access (API tier, no training on customer data)</td>
                    <td className="py-2">US</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4">Anthropic</td>
                    <td className="py-2 pr-4">AI inference (API tier, no training on customer data)</td>
                    <td className="py-2">US</td>
                  </tr>
                  <tr className="border-b">
                    <td className="py-2 pr-4">OpenAI</td>
                    <td className="py-2 pr-4">AI inference (API tier, no training on customer data)</td>
                    <td className="py-2">US</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* ── Data retention ── */}
          <section>
            <h2 className="text-lg font-semibold">Data retention</h2>
            <ul className="mt-3 list-disc pl-5 space-y-1 text-muted-foreground">
              <li>Account and project data is retained while your account is active.</li>
              <li>Analytics events are retained for up to 1 year.</li>
              <li>Session recordings are automatically deleted after 30 days.</li>
              <li>On account deletion, all personal data is removed within 30 days.</li>
            </ul>
          </section>

          {/* ── Where data is stored ── */}
          <section>
            <h2 className="text-lg font-semibold">Where your data is stored</h2>
            <p className="mt-3 text-muted-foreground">
              Frontier R&D Inc. is based in Canada and the United States. Our primary
              databases and services are hosted in the US. Cloudflare&rsquo;s global
              edge network caches and serves content from data centres worldwide,
              meaning some data may be transiently processed in other regions. We do
              not currently operate dedicated regional servers outside of the US, but
              this may change as the service grows.
            </p>
          </section>

          {/* ── European users (GDPR) ── */}
          <section>
            <h2 className="text-lg font-semibold">European users (GDPR)</h2>
            <div className="mt-3 space-y-3 text-muted-foreground">
              <p>
                If you are located in the European Economic Area (EEA), the UK, or
                Switzerland, you have additional rights under the General Data
                Protection Regulation (GDPR):
              </p>
              <ul className="list-disc pl-5 space-y-1">
                <li>
                  <strong className="text-foreground/90">Legal basis:</strong> We
                  process account and project data under contract necessity (to
                  provide the service) and legitimate interest (to operate, support,
                  and improve the service). Analytics and session recording are
                  enabled by default and accepted during onboarding; you may
                  withdraw consent at any time by opting out in Settings.
                </li>
                <li>
                  <strong className="text-foreground/90">Data transfers:</strong>{" "}
                  Your data is transferred to and processed in the United States and
                  may transit through Cloudflare&rsquo;s global edge network. We rely
                  on our processors&rsquo; Standard Contractual Clauses (SCCs) and
                  supplementary measures for lawful transfer.
                </li>
                <li>
                  <strong className="text-foreground/90">Your rights:</strong> You
                  may request access to, correction of, or deletion of your personal
                  data. You may also object to processing or request data
                  portability. Contact{" "}
                  <a href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-2">
                    {CONTACT_EMAIL}
                  </a>
                  .
                </li>
                <li>
                  <strong className="text-foreground/90">Supervisory authority:</strong>{" "}
                  You have the right to lodge a complaint with your local data
                  protection authority.
                </li>
              </ul>
            </div>
          </section>

          {/* ── Children ── */}
          <section>
            <h2 className="text-lg font-semibold">Children</h2>
            <p className="mt-3 text-muted-foreground">
              Aquilla is not directed at children under 13. We do not knowingly
              collect personal data from children under 13. If you believe a child
              has provided us with personal data, please contact us.
            </p>
          </section>

          {/* ── Changes ── */}
          <section>
            <h2 className="text-lg font-semibold">Changes to this policy</h2>
            <p className="mt-3 text-muted-foreground">
              We may update this policy from time to time. Material changes will be
              communicated via an in-app notice or email. Continued use of the
              service after changes take effect constitutes acceptance of the updated
              policy.
            </p>
          </section>

          {/* ── Contact ── */}
          <section>
            <h2 className="text-lg font-semibold">Contact</h2>
            <p className="mt-3 text-muted-foreground">
              For privacy questions or data requests, email{" "}
              <a href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-2">
                {CONTACT_EMAIL}
              </a>
              .
            </p>
          </section>
        </div>

        <div className="mt-16 border-t pt-6 text-xs text-muted-foreground">
          &copy; {new Date().getFullYear()} Frontier R&D Inc. All rights reserved.
        </div>
      </div>
    </div>
  )
}
