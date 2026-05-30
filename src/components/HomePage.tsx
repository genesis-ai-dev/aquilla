import {
  useEffect,
  useRef,
  type ComponentType,
  type ReactNode,
} from "react"
import { Link } from "react-router-dom"
import {
  ArrowRight,
  AudioLines,
  BrainCircuit,
  Check,
  Globe,
  Layers,
  Lock,
  ShieldCheck,
  Sparkles,
  Type,
  Users,
  Video,
  WifiOff,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useBrand } from "@/branding/use-brand"
import { cn } from "@/lib/utils"

/**
 * Public marketing landing page for Aquilla (served at /homepage).
 *
 * Design intent — hold two registers at once:
 *   • reverence / trust / enterprise  → calm violet gradients, generous
 *     whitespace, a serif voice for the "sacred" lines, full light+dark parity.
 *   • excitement / mission / acceleration → a living aurora, scroll reveals,
 *     and a marquee of languages in their native scripts.
 *
 * Everything is built from existing primitives + brand tokens (no new deps),
 * and all motion is disabled under `prefers-reduced-motion` (see index.css).
 */
export function HomePage() {
  const brand = useBrand()
  const Mark = brand.logo.Mark

  return (
    <div className="relative min-h-screen overflow-x-hidden bg-background text-foreground">
      <SiteNav markSlot={<Mark className="h-7 w-7 rounded-[22%]" aria-hidden />} name={brand.app.name} />
      <main>
        <Hero tagline={brand.app.tagline} />
        <LanguageBand />
        <MissionStatement />
        <WorkspaceTriad />
        <Intelligence />
        <TrustBand />
        <ClosingCta />
      </main>
      <SiteFooter
        markSlot={<Mark className="h-6 w-6 rounded-[22%]" aria-hidden />}
        name={brand.app.name}
        tagline={brand.app.tagline}
      />
    </div>
  )
}

/* ──────────────────────────────── chrome ──────────────────────────────── */

function SiteNav({ markSlot, name }: { markSlot: ReactNode; name: string }) {
  const links = [
    { label: "Mission", href: "#mission" },
    { label: "Workspace", href: "#workspace" },
    { label: "Intelligence", href: "#intelligence" },
    { label: "Trust", href: "#trust" },
  ]
  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
        <a href="#top" className="flex items-center gap-2.5">
          {markSlot}
          <span className="text-[15px] font-semibold tracking-tight">{name}</span>
        </a>
        <div className="hidden items-center gap-1 md:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="rounded-lg px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {l.label}
            </a>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Button
            render={<Link to="/onboarding" />}
            variant="ghost"
            size="lg"
            className="hidden sm:inline-flex"
          >
            Sign in
          </Button>
          <Button render={<Link to="/onboarding" />} size="lg">
            Create account
            <ArrowRight className="ml-0.5" />
          </Button>
        </div>
      </nav>
    </header>
  )
}

function SiteFooter({
  markSlot,
  name,
  tagline,
}: {
  markSlot: ReactNode
  name: string
  tagline: string
}) {
  return (
    <footer className="border-t border-border/60 bg-muted/30">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-4 px-5 py-12 text-center sm:px-8">
        <div className="flex items-center gap-2.5">
          {markSlot}
          <span className="text-sm font-semibold tracking-tight">{name}</span>
        </div>
        <p className="font-serif text-sm italic text-muted-foreground">{tagline}</p>
        <p className="max-w-md text-xs text-muted-foreground/80">
          Built for the Church and the field — so every people group can hear, read,
          and engage with the message in their own heart language.
        </p>
        <p className="mt-2 text-xs text-muted-foreground/70">
          © {new Date().getFullYear()} {name}. Free for everyone.
        </p>
      </div>
    </footer>
  )
}

/* ───────────────────────────────── hero ───────────────────────────────── */

function Hero({ tagline }: { tagline: string }) {
  // "Translation, lifted." → keep the period off "Translation," and italicize
  // the lifted word, matching the brand's poetic emphasis.
  const [lead, accentRaw] = tagline.split(",")
  const accent = (accentRaw ?? "lifted.").trim()
  return (
    <section id="top" className="relative isolate overflow-hidden">
      {/* aurora backdrop */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="hp-aurora-a absolute -top-40 left-1/2 h-[42rem] w-[42rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--primary)_38%,transparent),transparent)] blur-3xl" />
        <div className="hp-aurora-b absolute -top-24 right-[8%] h-[30rem] w-[30rem] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,oklch(0.7_0.14_240)_30%,transparent),transparent)] blur-3xl" />
        <div className="hp-aurora-b absolute top-32 left-[4%] h-[26rem] w-[26rem] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,oklch(0.74_0.13_300)_24%,transparent),transparent)] blur-3xl" />
        <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-background" />
      </div>

      <div className="mx-auto max-w-4xl px-5 pb-20 pt-20 text-center sm:px-8 sm:pt-28">
        <span className="hp-reveal inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/60 px-3.5 py-1.5 text-xs font-medium text-muted-foreground shadow-xs backdrop-blur">
          <Sparkles className="size-3.5 text-primary" />
          Built for Bible &amp; ministry translation
        </span>

        <h1 className="hp-reveal mt-7 text-balance text-5xl font-semibold leading-[1.04] tracking-tight sm:text-7xl">
          {lead},{" "}
          <em className="hp-grad-text font-serif not-italic">
            <span className="italic">{accent}</span>
          </em>
        </h1>

        <p className="hp-reveal mx-auto mt-6 max-w-2xl text-pretty text-lg leading-relaxed text-muted-foreground sm:text-xl">
          One workspace for text, audio, and video — with real-time guidance and a
          memory that learns. So every language can hear, read, and engage with the
          message.
        </p>

        <div className="hp-reveal mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button render={<Link to="/onboarding" />} size="lg" className="h-11 px-5 text-[15px]">
            Create account
            <ArrowRight className="ml-0.5" />
          </Button>
          <Button
            render={<Link to="/onboarding" />}
            variant="outline"
            size="lg"
            className="h-11 px-5 text-[15px]"
          >
            Sign in
          </Button>
        </div>

        <p className="hp-reveal mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
          {["Free for everyone", "No credit card", "Yours to keep"].map((t) => (
            <span key={t} className="inline-flex items-center gap-1.5">
              <Check className="size-3.5 text-primary" />
              {t}
            </span>
          ))}
        </p>
      </div>
      <ScrollReveal />
    </section>
  )
}

/* ───────────────────────── mission: every language ────────────────────── */

// Endonyms (each language's own name, in its own script) — accurate, reverent,
// and far more evocative than translating one verse into many tongues.
const ENDONYMS = [
  "English", "Español", "Português", "Français", "Deutsch", "Italiano", "Polski",
  "Русский", "Українська", "Ελληνικά", "עברית", "العربية", "فارسی", "اردو",
  "हिन्दी", "বাংলা", "தமிழ்", "తెలుగు", "ಕನ್ನಡ", "മലയാളം", "ગુજરાતી", "ਪੰਜਾਬੀ",
  "मराठी", "नेपाली", "සිංහල", "ไทย", "ລາວ", "ភាសាខ្មែរ", "မြန်မာ", "Tiếng Việt",
  "Bahasa Indonesia", "中文", "日本語", "한국어", "Монгол", "አማርኛ", "ትግርኛ",
  "Kiswahili", "Yorùbá", "Hausa", "isiZulu", "Afaan Oromoo", "Soomaali", "Türkçe",
  "Հայերեն", "ქართული", "Tagalog", "Te Reo Māori", "Runa Simi", "Nāhuatl",
  "Gàidhlig", "Cymraeg",
]

function LanguageBand() {
  // Two rows scrolling in opposite directions; each row's content is duplicated
  // so the -50% translate loops seamlessly.
  const rowA = ENDONYMS
  const rowB = [...ENDONYMS].reverse()
  return (
    <section
      aria-label="A few of the world's languages, in their own scripts"
      className="relative border-y border-border/60 bg-muted/20 py-8"
    >
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-background to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-background to-transparent" />
      <MarqueeRow items={rowA} direction="l" />
      <MarqueeRow items={rowB} direction="r" className="mt-4" />
    </section>
  )
}

function MarqueeRow({
  items,
  direction,
  className,
}: {
  items: string[]
  direction: "l" | "r"
  className?: string
}) {
  return (
    <div className={cn("flex overflow-hidden", className)}>
      <div
        className={cn(
          "hp-marquee-track flex shrink-0 items-center gap-3 pr-3",
          direction === "l" ? "hp-marquee-l" : "hp-marquee-r"
        )}
      >
        {[...items, ...items].map((label, i) => (
          <span
            key={`${label}-${i}`}
            className="whitespace-nowrap rounded-full border border-border/60 bg-background/70 px-4 py-1.5 text-sm text-foreground/80 shadow-xs"
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}

function MissionStatement() {
  return (
    <Section id="mission" className="relative text-center">
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-10 -z-10 h-72 w-72 -translate-x-1/2 rounded-full opacity-50 blur-3xl hp-halo" />
      <Eyebrow icon={Globe}>The mission</Eyebrow>
      <p className="hp-reveal mx-auto mt-5 text-balance text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
        Over <span className="hp-grad-text">7,000 languages</span> are spoken today.
      </p>
      <p className="hp-reveal mx-auto mt-5 max-w-2xl font-serif text-lg italic leading-relaxed text-muted-foreground sm:text-2xl">
        Every one of them deserves to hear, read, and engage with the message —
        clearly, faithfully, and in their own heart language.
      </p>
      <p className="hp-reveal mx-auto mt-6 max-w-xl text-pretty text-base leading-relaxed text-muted-foreground">
        Aquilla exists to compress the distance between that calling and its
        completion — giving every team the tools that, until now, only the
        best-resourced ones could afford.
      </p>
    </Section>
  )
}

/* ─────────────────────────── one workspace ────────────────────────────── */

function WorkspaceTriad() {
  const modes: {
    icon: ComponentType<{ className?: string }>
    title: string
    body: string
  }[] = [
    {
      icon: Type,
      title: "Text",
      body: "Draft, review, and check translations side-by-side with the source, verse by verse, with quality rules that catch issues as you type.",
    },
    {
      icon: AudioLines,
      title: "Audio",
      body: "Record, align, and refine oral translations and Scripture audio — karaoke-synced to the text, ready for oral-preference communities.",
    },
    {
      icon: Video,
      title: "Video",
      body: "Bring sign-language and visual translation into the same project, so no modality — and no community — is left out.",
    },
  ]
  return (
    <Section id="workspace">
      <div className="text-center">
        <Eyebrow icon={Layers}>One workspace</Eyebrow>
        <h2 className="hp-reveal mx-auto mt-5 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Text, audio, and video — under one roof.
        </h2>
        <p className="hp-reveal mx-auto mt-4 max-w-xl text-pretty text-muted-foreground">
          No more stitching together a half-dozen tools. Every modality lives in
          one project, with one source of truth.
        </p>
      </div>
      <div className="mt-12 grid gap-5 sm:grid-cols-3">
        {modes.map((m) => (
          <div
            key={m.title}
            className="hp-reveal group rounded-3xl border border-border/60 bg-card p-7 shadow-soft transition-all hover:-translate-y-1 hover:shadow-soft-lg"
          >
            <div className="inline-flex size-12 items-center justify-center rounded-2xl bg-accent text-accent-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
              <m.icon className="size-6" />
            </div>
            <h3 className="mt-5 text-lg font-semibold tracking-tight">{m.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{m.body}</p>
          </div>
        ))}
      </div>
    </Section>
  )
}

/* ───────────────────────────── intelligence ───────────────────────────── */

function Intelligence() {
  return (
    <Section id="intelligence">
      <div className="text-center">
        <Eyebrow icon={Sparkles}>Intelligence</Eyebrow>
        <h2 className="hp-reveal mx-auto mt-5 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Guidance that never sleeps. <br className="hidden sm:block" />
          Memory that compounds.
        </h2>
      </div>

      <div className="mt-12 grid items-center gap-8 lg:grid-cols-2">
        <div className="space-y-6">
          <FeatureRow
            icon={Sparkles}
            title="Real-time guidance"
            body="Naturalness, consistency, and faithfulness checks run as you work — surfacing the right suggestion at the right moment, never interrupting the flow."
          />
          <FeatureRow
            icon={BrainCircuit}
            title="A memory that learns"
            body="Every decision your team makes — key terms, names, stylistic choices — is remembered and reapplied, so the project gets smarter with every verse."
          />
          <FeatureRow
            icon={Users}
            title="Built for teams"
            body="Translators, consultants, and reviewers work in the same room with roles, comments, and a shared history — across the office or across an ocean."
          />
        </div>

        {/* A restrained mock of the workspace, built from brand tokens so it
            reads as "the real thing" without shipping a screenshot. */}
        <div className="hp-reveal">
          <WorkspaceMock />
        </div>
      </div>
    </Section>
  )
}

function WorkspaceMock() {
  return (
    <div className="overflow-hidden rounded-3xl border border-border/70 bg-card shadow-soft-lg">
      <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/40 px-4 py-3">
        <span className="size-2.5 rounded-full bg-destructive/50" />
        <span className="size-2.5 rounded-full bg-chart-4" />
        <span className="size-2.5 rounded-full bg-chart-3" />
        <span className="ml-3 text-xs text-muted-foreground">John · Chapter 1</span>
      </div>
      <div className="space-y-3 p-5">
        <MockRow ref_="1:1" source="In the beginning was the Word…" target="Tcommencement, the Word he stop…" status="check" />
        <MockRow ref_="1:2" source="The same was in the beginning with God." target="Him he stop alongside God…" status="ok" />
        <MockRow ref_="1:3" source="All things were made by him…" target="" status="draft" />
        <div className="!mt-4 flex items-center gap-2 rounded-2xl bg-accent/60 p-3 text-xs text-accent-foreground">
          <Sparkles className="size-4 shrink-0 text-primary" />
          <span>
            <strong className="font-medium">Memory:</strong> “Word” → keep capitalized
            (title for Christ). Applied in 3 places.
          </span>
        </div>
      </div>
    </div>
  )
}

function MockRow({
  ref_,
  source,
  target,
  status,
}: {
  ref_: string
  source: string
  target: string
  status: "ok" | "check" | "draft"
}) {
  const dot =
    status === "ok" ? "bg-chart-3" : status === "check" ? "bg-chart-4" : "bg-border"
  return (
    <div className="grid grid-cols-[2.5rem_1fr_1fr] items-start gap-3 text-xs">
      <span className="pt-0.5 font-mono text-muted-foreground">{ref_}</span>
      <span className="leading-relaxed text-muted-foreground">{source}</span>
      <span className="flex items-start gap-1.5 leading-relaxed">
        <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", dot)} />
        <span className={target ? "text-foreground" : "italic text-muted-foreground/60"}>
          {target || "—"}
        </span>
      </span>
    </div>
  )
}

function FeatureRow({
  icon: Icon,
  title,
  body,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  body: string
}) {
  return (
    <div className="hp-reveal flex gap-4">
      <div className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
        <Icon className="size-5" />
      </div>
      <div>
        <h3 className="font-semibold tracking-tight">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}

/* ────────────────────────── trust / enterprise ────────────────────────── */

function TrustBand() {
  const pillars: {
    icon: ComponentType<{ className?: string }>
    title: string
    body: string
  }[] = [
    {
      icon: WifiOff,
      title: "Offline-first",
      body: "Works where the work happens — in the field, on weak connections. Sync catches up when you're back online.",
    },
    {
      icon: Lock,
      title: "Your data, yours",
      body: "Projects live with you and your team. Export anytime in open formats; nothing is held hostage.",
    },
    {
      icon: ShieldCheck,
      title: "Enterprise-grade",
      body: "Role-based access, project history, and the security posture organizations require — without the friction.",
    },
    {
      icon: Globe,
      title: "Free for everyone",
      body: "The full toolset, given freely. Because the mission is too important to put behind a paywall.",
    },
  ]
  return (
    <section id="trust" className="relative isolate overflow-hidden py-24 sm:py-32">
      <div aria-hidden className="absolute inset-0 -z-10 bg-gradient-to-b from-primary/[0.06] via-background to-background" />
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <div className="text-center">
          <Eyebrow icon={ShieldCheck}>Trust</Eyebrow>
          <h2 className="hp-reveal mx-auto mt-5 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Serious enough for institutions. <br className="hidden sm:block" />
            Open enough for everyone.
          </h2>
        </div>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {pillars.map((p) => (
            <div
              key={p.title}
              className="hp-reveal rounded-3xl border border-border/60 bg-card/70 p-6 shadow-soft backdrop-blur"
            >
              <div className="inline-flex size-11 items-center justify-center rounded-2xl bg-accent text-primary">
                <p.icon className="size-5" />
              </div>
              <h3 className="mt-4 font-semibold tracking-tight">{p.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/* ────────────────────────────── closing cta ───────────────────────────── */

function ClosingCta() {
  return (
    <section className="px-5 pb-28 sm:px-8">
      <div className="relative mx-auto max-w-5xl overflow-hidden rounded-[2rem] border border-border/60 px-6 py-16 text-center shadow-soft-lg sm:py-20">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="hp-aurora-a absolute -top-32 left-1/2 h-[28rem] w-[28rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--primary)_40%,transparent),transparent)] blur-3xl" />
          <div className="absolute inset-0 bg-gradient-to-b from-primary/[0.08] to-background/40" />
        </div>
        <h2 className="hp-reveal mx-auto max-w-2xl text-balance text-3xl font-semibold leading-tight tracking-tight sm:text-5xl">
          The message, in every language.
          <br />
          <span className="hp-grad-text font-serif italic">Let’s accelerate.</span>
        </h2>
        <p className="hp-reveal mx-auto mt-5 max-w-xl text-pretty text-muted-foreground">
          Start a project in minutes. Bring your team. Keep your work. It’s free,
          and it’s ready.
        </p>
        <div className="hp-reveal mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button render={<Link to="/onboarding" />} size="lg" className="h-12 px-6 text-base">
            Create your free account
            <ArrowRight className="ml-0.5" />
          </Button>
          <Button
            render={<Link to="/onboarding" />}
            variant="outline"
            size="lg"
            className="h-12 px-6 text-base"
          >
            Sign in
          </Button>
        </div>
      </div>
    </section>
  )
}

/* ───────────────────────────── shared bits ────────────────────────────── */

function Section({
  id,
  className,
  children,
}: {
  id?: string
  className?: string
  children: ReactNode
}) {
  return (
    <section id={id} className={cn("mx-auto max-w-6xl px-5 py-24 sm:px-8 sm:py-32", className)}>
      {children}
    </section>
  )
}

function Eyebrow({
  icon: Icon,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  children: ReactNode
}) {
  return (
    <span className="hp-reveal inline-flex items-center gap-2 rounded-full border border-border/70 bg-background/60 px-3.5 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground shadow-xs">
      <Icon className="size-3.5 text-primary" />
      {children}
    </span>
  )
}

/**
 * Adds `.hp-in` to every `.hp-reveal` as it scrolls into view, with a small
 * stagger per intersecting batch. Falls back to "all visible" when
 * IntersectionObserver is unavailable.
 */
function ScrollReveal() {
  const armed = useRef(false)
  useEffect(() => {
    if (armed.current) return
    armed.current = true

    const nodes = Array.from(document.querySelectorAll<HTMLElement>(".hp-reveal"))
    if (!("IntersectionObserver" in window) || nodes.length === 0) {
      nodes.forEach((n) => n.classList.add("hp-in"))
      return
    }

    const io = new IntersectionObserver(
      (entries) => {
        let stagger = 0
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const el = entry.target as HTMLElement
          el.style.animationDelay = `${stagger * 80}ms`
          el.classList.add("hp-in")
          io.unobserve(el)
          stagger += 1
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 }
    )
    nodes.forEach((n) => io.observe(n))
    return () => io.disconnect()
  }, [])
  return null
}
