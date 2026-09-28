# Frontier R&D Partner Newsletter — Playbook

_A monthly letter from Joel (Head of Partnerships) to the organizations
building on Frontier R&D's products — **Aquilla, Codex, and LangQuest**.
Established 2026-08 (closes LEAD-62: recurring partner comms rhythm instead
of bespoke messaging)._

## The one rule

**Nothing is ever sent without Joel reading it.** The pipeline drafts; Joel
edits and sends. An auto-generated letter that reaches a partner unreviewed
is a trust incident, not a time saving. This mirrors the Marketing Operating
System's Level-2+ gate: agents draft, humans own external communications.

## What it is (and is not)

- A **Resend broadcast that reads like a personal email**. From:
  "Joel Maves" <joel@news.frontierrnd.com> (dedicated sending subdomain),
  Reply-To: joel@frontierrnd.com so replies land in Joel's real inbox.
  Lightly styled HTML (bold section subtitles, nothing more). Open/click
  tracking stays **OFF** — no pixels, banners, or buttons. The audience is
  dozens of partner organizations (Biblica, ETEN, Spoken, BibleProject,
  BSA, …), not a mass list. Body signature is unchanged: Joel Maves.
- **One letter, three products.** Distinct sections for Aquilla, Codex, and
  LangQuest. A quiet product gets one honest line or is omitted (noted in
  the run summary) — never padded.
- **Curated.** The homepage form (`#partner-letter`) is a *request*, not a
  subscription. Joel approves each requester.
- Subject: `Frontier R&D partner newsletter — <Month> <Year>` — named at the
  Frontier level on purpose: one newsletter, all apps (Aquilla, Codex,
  LangQuest, and whatever ships next).

## Cadence

| When (America/Toronto) | What | Who |
|---|---|---|
| ~26th (reminder ping) | Joel asks leadership (Caleb, Matthew, Ryder) **in Discord**: "what headlines do you want in this month's partner letter — Aquilla, Codex, or LangQuest?" — then pastes the answers into an email to himself with subject **"Partner newsletter headlines — <Month> <Year>"** | Joel |
| 1st of the month, ~7:00 | Scheduled task: (a) **archives** any sent edition from last cycle to the Drive archive, (b) reads the headlines email, (c) gathers last month's material per product, cross-references, and creates a **Gmail draft** (HTML + plain text), then notifies Joel | automated |
| 1st–4th | Joel edits the draft — cuts, corrects, adds the human bits the pipeline can't know | Joel |
| By the 5th | Joel sends via **Resend**: new Broadcast → audience "Frontier R&D Newsletter" → paste the reviewed content from the Gmail draft → send. From "Joel Maves" <joel@news.frontierrnd.com>, Reply-To joel@frontierrnd.com | Joel |

Two scheduled tasks live in Claude (Cowork scheduled tasks):
**"Partner newsletter — headline ask reminder"** (26th) and
**"Partner newsletter — monthly draft"** (1st). Edit or pause them there.

## The archive (industry practice: every issue is findable)

Google Drive folder **"Partner Letter — Archive"**
(https://drive.google.com/drive/folders/1flNRAVO9oB17pr7mKbbituTMwBGidZLH).

- One Google Doc per edition, named `YYYY-MM — Partner newsletter (<Month> <Year>)`
  — the name convention keeps the folder self-indexing. (The pipeline matches
  existing docs by the `YYYY-MM` prefix, so earlier "Partner letter" names
  still count.)
- Each doc holds: STATUS line, briefing notes (headlines received, what was
  flagged/corrected), and the letter text. **The sent email is the source of
  truth**; the monthly run archives the sent version automatically before
  drafting the next one (archive-then-draft), so the archive never drifts
  from what partners actually received.
- The folder also holds two learning-loop artifacts:
  `YYYY-MM — Raw draft (<Month> <Year>)` — a snapshot of exactly what the
  pipeline drafted, saved at draft time — and **"Standing corrections &
  preferences"**, a doc of durable rules the drafting task reads every month
  (ranked below this playbook, above the task's defaults).
- A **mirror of this playbook** also lives in the folder ("PLAYBOOK —
  Frontier R&D partner newsletter"), so scheduled runs can follow it even
  when the repo folder isn't connected. The repo copy is the source of
  truth — update the mirror whenever this file changes.
- Use it to: check what was already told to partners, onboard a new
  subscriber ("here are the last three letters"), and give leadership a
  no-login place to read back issues.

## Adjustment points (how the workflow gets steered and gets better)

1. **Before drafting (26th):** the headlines email — add topics, kill
   topics, attach evidence. Evidence-backed headlines are asserted plainly.
2. **Before sending (1st–4th):** Joel's review window. Anything can change;
   nothing sends without him.
3. **Anytime (structural):** edit this playbook or the scheduled tasks —
   cadence, sections, tone, guardrails, pausing a month.
4. **After sending (the learning loop):** each run diffs the previous sent
   edition against its raw-draft snapshot and reports Joel's edits as
   candidate standing corrections. Joel approves which become durable rules
   in the "Standing corrections & preferences" doc — so the same class of
   edit shouldn't need making twice. The pipeline proposes; only Joel
   promotes a correction to a standing rule.

## Content sources (per product)

| Product | Linear team | Repo | Notes |
|---|---|---|---|
| Aquilla | Aquilla | github.com/genesis-ai-dev/aquilla (private; local folder when connected) | CHANGES.md, docs/ |
| Codex | Codex | github.com/genesis-ai-dev/codex-editor (public) | releases/commits fetchable even in scheduled runs |
| LangQuest | LangQuest | github.com/genesis-ai-dev/langquest (public) | releases/commits fetchable even in scheduled runs |

Plus, cross-product:

1. **Leadership headlines** — the "Partner newsletter headlines — <Month>" email
   (pasted from the Discord ask; tag each headline with its product).
   **Claims to verify, not copy to paste**: verified headlines lead their
   product's section; unverified or contradicted ones are flagged in the run
   summary for Joel — never silently included. Tip: one line of evidence per
   headline ("passed e2e 7/31, AQU-506") turns hedging into confident copy.
2. **Zoom** — partner-call summaries from the month.
3. **Frontier Leadership Linear team** — partner-safe business decisions.
4. **Joel's sent mail** — what has already been promised or communicated.

## Letter structure

Subject: `Frontier R&D partner newsletter — <Month> <Year>`

1. **Personal opener** (1–2 lines, Joel's voice).
2. **Aquilla** — bold subhead; 2–5 bullets mixing shipped + coming.
3. **Codex** — same.
4. **LangQuest** — same.
5. **What we need from you** — one or two specific cross-product asks.
6. **Sign-off** — "I will write again in early <next month>." + "Joel Maves
   / Head of Partnerships, Frontier R&D".
7. **Footer (always, small gray text):** *"You're receiving this because
   your organization partners with Frontier R&D. Reply 'remove' any time —
   or unsubscribe in one click: {{{RESEND_UNSUBSCRIBE_URL}}}"* — Resend
   resolves the merge tag at send time and handles suppression automatically
   (CASL/CAN-SPAM). Reply-removals are honored same-day by removing the
   contact in Resend.

## Email styling (restrained HTML)

The draft is created with an HTML body plus a plain-text fallback. Styling
exists to aid scanning, not to look like marketing:

- Single column, `max-width: 640px`, Arial/Helvetica, 15px, `#111` text.
- Product names and "What we need from you" as bold subheads (16px, `<h3>`).
- Bullets as short paragraphs with a **bold label** then a colon.
- Footer: 12px, gray (`#6b7280`), thin top border.
- **Never:** images, banners, buttons, multi-column layout, background
  colors, emoji, centered text.

Template skeleton:

```html
<div style="max-width:640px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111">
  <p>Hi everyone,</p>
  <p>[opener]</p>
  <h3 style="font-size:16px;margin:24px 0 8px">Aquilla</h3>
  <p style="margin:0 0 12px"><strong>[Label]:</strong> [detail]</p>
  <h3 style="font-size:16px;margin:24px 0 8px">Codex</h3>
  <p style="margin:0 0 12px"><strong>[Label]:</strong> [detail]</p>
  <h3 style="font-size:16px;margin:24px 0 8px">LangQuest</h3>
  <p style="margin:0 0 12px"><strong>[Label]:</strong> [detail]</p>
  <h3 style="font-size:16px;margin:24px 0 8px">What we need from you</h3>
  <p style="margin:0 0 12px">[ask]</p>
  <p>[closing]</p>
  <p>Joel Maves<br>Head of Partnerships, Frontier R&amp;D</p>
  <p style="font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb;padding-top:12px;margin-top:24px">You're receiving this because your organization partners with Frontier R&amp;D. Reply "remove" any time and I'll take you off the list.</p>
</div>
```

## Voice profile (from Joel's actual sent mail)

- **Greeting:** "Hi everyone," for the list; "Hi <name>," for individuals.
- **Opener:** one warm line, then straight to substance. Gratitude-forward.
- **Structure:** short paragraphs; bullets with a bold label then a colon;
  concrete dates and named people ("Ryder demoed at the UBS conference in
  Manila").
- **Always states his own next action:** "I will verify these details with
  Ryder and circle back next week."
- **Tone:** warm, plain, humble, professional. No hype words (never
  "excited to announce", "game-changing"). Exclamation marks sparingly.
- **References the team by name and role:** "my CEO, Ryder".
- **Sign-offs:** "Joel" / "Joel Maves"; "Best regards, Joel" in formal
  contexts.

## Editorial guardrails — what NEVER goes in

- **Security issues or embarrassing bug details.** Describe as "hardening"
  or "stability" themes at most.
- **Unshipped promises with new dates.** Dates appear only if already
  communicated to partners or explicitly confirmed for the letter.
- **One partner's confidential info to the rest** — project names, volumes,
  contract terms, staffing. "Four new language projects launched" is fine;
  naming the reviewer an org hired is not.
- **Internal business details** — finances, hiring, pricing under
  discussion, internal disagreements.
- **Roadmap items still under debate.**

When in doubt, cut. The letter's job is trust, not completeness.

## Subscriber flow

1. Visitor uses the shareable link **https://aquilla.app/newsletter**
   or the homepage **partner-letter** section — both served by the
   separate **`aquilla-marketing`** repo (AQU-918 moved the whole public
   marketing surface out of this repo) → `POST /api/v2/contact/newsletter`
   (auth-worker `routes/contact.ts`, honeypot + per-IP throttle) → request
   email lands in joel@frontierrnd.com. Still a REQUEST — the shareable
   link did not change the curation model.
2. **Approve:** add the contact to the Resend audience
   **"Frontier R&D Newsletter"** and reply with a one-line welcome
   (consider attaching the last edition from the archive).
   **Decline:** reply politely or archive. Nothing is stored server-side.
3. Existing partners can be added directly (existing business relationship
   under CASL; the footer's unsubscribe covers the rest).
4. **Removals:** Resend's one-click unsubscribe is automatic; "remove"
   replies are honored same-day by removing the contact in Resend.

Joel is a member of his own audience, so every sent edition lands in his
inbox — that received copy is what the pipeline archives.

## Where the pieces live

- Signup page + homepage section: the **`aquilla-marketing`** repo (they
  POST cross-origin to the endpoint below). Not in this repo.
- Endpoint: `auth-worker/src/routes/contact.ts` → `POST /newsletter`
  (+ `auth-worker/src/__tests__/newsletter-request.test.ts`)
- Notification email copy: `auth-worker/src/services/email.ts`
  (`buildNewsletterRequestEmail`)
- List of record: Resend audience "Frontier R&D Newsletter" (sending
  domain: news.frontierrnd.com; tracking OFF)
- Shareable subscribe link: https://aquilla.app/newsletter
  (served by the `aquilla-marketing` Worker)
- Archive: Drive folder "Partner Letter — Archive" (link above), including
  the "Standing corrections & preferences" doc and this playbook's mirror
- Automation: Claude scheduled tasks "Partner newsletter — headline ask
  reminder" (26th) and "Partner newsletter — monthly draft" (1st)
- This playbook: `docs/partner-newsletter/PLAYBOOK.md` (source of truth;
  the Drive mirror is a copy for headless runs and quick reference)
