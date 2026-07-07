# Generic Homepage + Unlisted BT Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the current Bible-oriented marketing homepage into an unlisted, noindex Bible-translation (BT) landing page and a rewritten, Bible-free public homepage.

**Architecture:** Duplicate the three Bible-oriented homepage files verbatim into new `*BT`/`BibleTranslationLanding` files served by a new static entry point (`/bible-translation`, noindex). Then edit the original files in place to become the generic public homepage (still served at `/` and `/homepage` — no change to that routing).

**Tech Stack:** React 19, Vite (rolldown, multi-page `input` build), Cloudflare Workers (static asset routing), Vitest + Testing Library.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-07-generic-homepage-bt-unlisted-design.md`
- No billing/payment code changes — the $45/project/mo tier is copy-only, CTA is disabled/waitlist, not a live purchase flow.
- No changes to `/`, `/homepage`, auth, onboarding, or SPA routing beyond the one new `/bible-translation` static mapping.
- No restyle — reuse `homepage.css`, `BetaBar.tsx`, `useMarketingShell.ts` unchanged (verified Bible-free) for both pages.
- `pnpm build` must succeed with three HTML entries (`index`, `homepage`, `bible-translation`) after this work, alongside the existing `beta`/`case-study`/`case-study-biblica` entries.

---

### Task 1: Duplicate the BT page's React components (unchanged content)

**Files:**
- Create: `src/pages/Homepage/BibleTranslationLanding.tsx` (copy of `src/pages/Homepage/Homepage.tsx`)
- Create: `src/pages/Homepage/MultimodalWorkspaceBT.tsx` (copy of `src/pages/Homepage/MultimodalWorkspace.tsx`)
- Create: `src/pages/Homepage/LanguageBlitzBT.tsx` (copy of `src/pages/Homepage/LanguageBlitz.tsx`)
- Create: `src/pages/Homepage/BibleTranslationLanding.login-link.test.tsx` (copy of `src/pages/Homepage/Homepage.login-link.test.tsx`)
- Test: same file as above (this task's deliverable is verified by that test)

**Interfaces:**
- Consumes: nothing new — `john316.data.ts`, `HealthRing`, `AppTooltip`, `useBrand`, `hasAuthHintCookie`, `BetaBar`, `useMarketingShell` all stay as they are today.
- Produces: `BibleTranslationLanding` (named export, same props signature as `Homepage`: none), `MultimodalWorkspaceBT` (named export, same props as `MultimodalWorkspace`: `{ theme?: "light" | "dark" }`), `LanguageBlitzBT` + `LanguageMarquee` are NOT renamed in the BT copy (the marquee stays named `LanguageMarquee` inside `LanguageBlitzBT.tsx` — later tasks importing the generic `LanguageBlitz.tsx` keep using its own `LanguageMarquee`, so there's no cross-file name collision since these are two separate files).

- [ ] **Step 1: Copy the three component files verbatim**

```bash
cp src/pages/Homepage/Homepage.tsx src/pages/Homepage/BibleTranslationLanding.tsx
cp src/pages/Homepage/MultimodalWorkspace.tsx src/pages/Homepage/MultimodalWorkspaceBT.tsx
cp src/pages/Homepage/LanguageBlitz.tsx src/pages/Homepage/LanguageBlitzBT.tsx
```

- [ ] **Step 2: Rewire `BibleTranslationLanding.tsx`'s imports to the BT copies and rename its export**

In `src/pages/Homepage/BibleTranslationLanding.tsx`:

```ts
// change:
import { MultimodalWorkspace } from "./MultimodalWorkspace"
import { LanguageBlitz, LanguageMarquee } from "./LanguageBlitz"
// to:
import { MultimodalWorkspace } from "./MultimodalWorkspaceBT"
import { LanguageBlitz, LanguageMarquee } from "./LanguageBlitzBT"
```

```ts
// change:
export function Homepage() {
// to:
export function BibleTranslationLanding() {
```

Leave every other line (JSX, copy, icons, `WorkspaceBoundary`) untouched — this file's content must stay byte-identical to the original Bible-oriented copy except for these two import lines and the function name.

- [ ] **Step 3: Update the duplicated test file to match the new component/module names**

In `src/pages/Homepage/BibleTranslationLanding.login-link.test.tsx`, apply these renames (everything else — the two `it()` bodies, mock cookie logic — stays the same):

```ts
import { BibleTranslationLanding } from "./BibleTranslationLanding"

vi.mock("./MultimodalWorkspaceBT", () => ({
  MultimodalWorkspace: () => null,
}))

vi.mock("./LanguageBlitzBT", () => ({
  LanguageBlitz: () => null,
  LanguageMarquee: () => null,
}))
```

```ts
function renderHomepage() {
  return render(
    <MemoryRouter>
      <BibleTranslationLanding />
    </MemoryRouter>,
  )
}
```

Update the `describe` block title to `"BibleTranslationLanding — Open app link target (FRO-282)"`.

- [ ] **Step 4: Run the new test file**

Run: `pnpm test src/pages/Homepage/BibleTranslationLanding.login-link.test.tsx`
Expected: both tests PASS (`/login` when signed out, `/` when `aq_hint` cookie present).

- [ ] **Step 5: Commit**

```bash
git add src/pages/Homepage/BibleTranslationLanding.tsx src/pages/Homepage/MultimodalWorkspaceBT.tsx src/pages/Homepage/LanguageBlitzBT.tsx src/pages/Homepage/BibleTranslationLanding.login-link.test.tsx
git commit -m "feat(homepage): duplicate BT landing page components ahead of public homepage rewrite"
```

---

### Task 2: Add the `/bible-translation` static entry point (build + Worker + robots)

**Files:**
- Create: `bible-translation.html` (copy of `homepage.html`, unchanged hero copy, adds noindex meta)
- Create: `src/bt-main.tsx` (copy of `src/homepage-main.tsx`, mounts `BibleTranslationLanding`)
- Create: `public/robots.txt`
- Modify: `vite.config.ts` (add `bible-translation` to `rolldownOptions.input`)
- Modify: `worker/index.ts:23-28` (add `/bible-translation` to `STATIC_PAGES`)
- Test: `worker/index.test.ts`

**Interfaces:**
- Consumes: `BibleTranslationLanding` from Task 1.
- Produces: `dist/bible-translation.html` build output; Worker route `"/bible-translation": "/bible-translation.html"` in `STATIC_PAGES`.

- [ ] **Step 1: Create `bible-translation.html`**

Copy `homepage.html` verbatim, then add the noindex meta tag and point the mount script at the new entry:

```bash
cp homepage.html bible-translation.html
```

Edit `bible-translation.html`:

```html
    <meta name="description" content="%BRAND_DESCRIPTION%" />
    <meta name="robots" content="noindex, nofollow" />
    <title>%BRAND_TITLE%</title>
```

(insert the `robots` meta line directly after the existing `description` meta line)

```html
    <script type="module" src="/src/bt-main.tsx"></script>
```

(replace the `homepage-main.tsx` script src at the bottom of the file — this is the only other line that changes; the pre-mount hero markup and all `%BRAND_*%` placeholders stay identical to `homepage.html`)

- [ ] **Step 2: Create `src/bt-main.tsx`**

```tsx
// Standalone entry for the unlisted Bible-translation (BT) landing page.
// Direct-link only — noindex via bible-translation.html's <meta> tag and
// robots.txt; never linked from nav, footer, or any sitemap. See
// docs/superpowers/specs/2026-07-07-generic-homepage-bt-unlisted-design.md
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import { brand } from "./branding/current-brand"
import { applyTheme } from "./branding/apply-theme"
import { BrandProvider } from "./branding/BrandProvider"
import { BibleTranslationLanding } from "./pages/Homepage/BibleTranslationLanding"

applyTheme(brand)
document.title = brand.app.htmlTitle

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrandProvider>
      <BibleTranslationLanding />
    </BrandProvider>
  </StrictMode>,
)
```

- [ ] **Step 3: Add the build entry in `vite.config.ts`**

In the `rolldownOptions.input` object (around line 144-150), add one line:

```ts
      input: {
        index: path.resolve(__dirname, "index.html"),
        homepage: path.resolve(__dirname, "homepage.html"),
        "bible-translation": path.resolve(__dirname, "bible-translation.html"),
        beta: path.resolve(__dirname, "beta.html"),
        "case-study": path.resolve(__dirname, "case-study.html"),
        "case-study-biblica": path.resolve(__dirname, "case-study-biblica.html"),
      },
```

- [ ] **Step 4: Add the Worker static-route mapping**

In `worker/index.ts`, extend `STATIC_PAGES` (lines 23-28):

```ts
const STATIC_PAGES: Record<string, string> = {
  "/homepage": "/homepage.html",
  "/bible-translation": "/bible-translation.html",
  "/beta": "/beta.html",
  "/case-studies/come-and-see": "/case-study.html",
  "/case-studies/biblica": "/case-study-biblica.html",
}
```

- [ ] **Step 5: Write the failing Worker routing test**

In `worker/index.test.ts`, add after the existing `/beta` tests (after line 78's block):

```ts
  it("GET /bible-translation always serves bible-translation.html (no cookie)", async () => {
    const res = await fetchWorker("/bible-translation")
    expect(await res.text()).toBe("served:/bible-translation.html")
  })

  it("GET /bible-translation always serves bible-translation.html (even with aq_hint=1)", async () => {
    const res = await fetchWorker("/bible-translation", "aq_hint=1")
    expect(await res.text()).toBe("served:/bible-translation.html")
  })
```

- [ ] **Step 6: Run the Worker test to verify it fails, then passes**

Run: `pnpm --filter . exec vitest run worker/index.test.ts` (or from repo root: `npx vitest run worker/index.test.ts`)
Expected before Step 4/5's edits: n/a (edits already applied in order above) — run now and expect PASS, since `STATIC_PAGES` was already updated in Step 4.

- [ ] **Step 7: Add `public/robots.txt`**

No `robots.txt` exists in this repo yet. Create one with a general allow-all plus the explicit BT disallow (defense-in-depth alongside the page's own noindex meta):

```
User-agent: *
Disallow: /bible-translation
```

- [ ] **Step 8: Build to confirm all entries compile**

Run: `pnpm build`
Expected: build succeeds; `dist/bible-translation.html`, `dist/homepage.html`, `dist/index.html` all present (check with `ls dist/*.html`).

- [ ] **Step 9: Commit**

```bash
git add bible-translation.html src/bt-main.tsx public/robots.txt vite.config.ts worker/index.ts worker/index.test.ts
git commit -m "feat(homepage): serve unlisted /bible-translation page (noindex, direct-link only)"
```

---

### Task 3: Add UDHR sample data + genericize `LanguageBlitz.tsx` (public homepage)

**Files:**
- Create: `src/pages/Homepage/udhr-article1.data.ts`
- Modify: `src/pages/Homepage/LanguageBlitz.tsx` (public copy only — `LanguageBlitzBT.tsx` from Task 1 is untouched)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SampleEntry` interface and `UDHR_ARTICLE1: SampleEntry[]` export, consumed by `LanguageBlitz.tsx`'s `DATA` constant in place of `JOHN_316`.

- [ ] **Step 1: Create the UDHR data file**

```ts
// src/pages/Homepage/udhr-article1.data.ts
//
// Universal Declaration of Human Rights, Article 1 — a secular, public-domain
// analog to the eBible corpus used on the BT landing page. UDHR is
// professionally translated into 500+ languages and is itself marketed by the
// UN as "the most translated document in the world," making it a credible
// multilingual proof point with no religious content.
//
// Text sourced from established published UDHR translations; verify the
// less-common-language entries (Amharic, Georgian) against an authoritative
// source before launch — same caveat the Come-and-See stats carry elsewhere
// on this page.

export interface SampleEntry {
  code: string
  name: string
  en: string
  text: string
  dir: "ltr" | "rtl"
  script: string
  domain: string
}

const EN = "All human beings are born free and equal in dignity and rights. They are endowed with reason and conscience and should act towards one another in a spirit of brotherhood."

export const UDHR_ARTICLE1: SampleEntry[] = [
  { code: "eng", name: "English", en: EN, text: EN, dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "spa", name: "Español", en: EN, text: "Todos los seres humanos nacen libres e iguales en dignidad y derechos y, dotados como están de razón y conciencia, deben comportarse fraternalmente los unos con los otros.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "fra", name: "Français", en: EN, text: "Tous les êtres humains naissent libres et égaux en dignité et en droits. Ils sont doués de raison et de conscience et doivent agir les uns envers les autres dans un esprit de fraternité.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "arb", name: "العربية", en: EN, text: "يولد جميع الناس أحرارًا متساوين في الكرامة والحقوق، وقد وهبوا عقلاً وضميرًا وعليهم أن يعامل بعضهم بعضاً بروح الإخاء.", dir: "rtl", script: "Arabic", domain: "udhr" },
  { code: "cmn", name: "中文", en: EN, text: "人人生而自由,在尊严和权利上一律平等。他们赋有理性和良心,并应以兄弟关系的精神相对待。", dir: "ltr", script: "Han", domain: "udhr" },
  { code: "rus", name: "Русский", en: EN, text: "Все люди рождаются свободными и равными в своем достоинстве и правах. Они наделены разумом и совестью и должны поступать в отношении друг друга в духе братства.", dir: "ltr", script: "Cyrillic", domain: "udhr" },
  { code: "hin", name: "हिन्दी", en: EN, text: "सभी मनुष्यों को गौरव और अधिकारों के मामले में जन्मजात स्वतन्त्रता और समानता प्राप्त है। उन्हें बुद्धि और अन्तरात्मा की देन प्राप्त है और परस्पर उन्हें भाईचारे के भाव से बर्ताव करना चाहिए।", dir: "ltr", script: "Devanagari", domain: "udhr" },
  { code: "ben", name: "বাংলা", en: EN, text: "সমস্ত মানুষ স্বাধীনভাবে সমান মর্যাদা এবং অধিকার নিয়ে জন্মগ্রহণ করে। তাঁদের বিবেক এবং বুদ্ধি আছে; সুতরাং সকলেরই একে অপরের প্রতি ভ্রাতৃত্বসুলভ মনোভাব নিয়ে আচরণ করা উচিত।", dir: "ltr", script: "Bengali", domain: "udhr" },
  { code: "por", name: "Português", en: EN, text: "Todos os seres humanos nascem livres e iguais em dignidade e em direitos. Dotados de razão e de consciência, devem agir uns para com os outros em espírito de fraternidade.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "deu", name: "Deutsch", en: EN, text: "Alle Menschen sind frei und gleich an Würde und Rechten geboren. Sie sind mit Vernunft und Gewissen begabt und sollen einander im Geist der Brüderlichkeit begegnen.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "jpn", name: "日本語", en: EN, text: "すべての人間は、生まれながらにして自由であり、かつ、尊厳と権利とについて平等である。人間は、理性と良心とを授けられており、互いに同胞の精神をもって行動しなければならない。", dir: "ltr", script: "Han / Kana", domain: "udhr" },
  { code: "kor", name: "한국어", en: EN, text: "모든 인간은 태어날 때부터 자유로우며 그 존엄과 권리에 있어 동등하다. 인간은 천부적으로 이성과 양심을 부여받았으며 서로 형제애의 정신으로 행동하여야 한다.", dir: "ltr", script: "Hangul", domain: "udhr" },
  { code: "swh", name: "Kiswahili", en: EN, text: "Watu wote wamezaliwa huru, hadhi na haki zao ni sawa. Wote wamejaliwa akili na dhamiri, hivyo yapasa kutendeana kindugu.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "amh", name: "አማርኛ", en: EN, text: "ሁሉም ሰዎች ነጻ ሆነው የተወለዱ ናቸው፣ በክብርና በመብትም እኩል ናቸው። የተፈጥሮ የማስተዋልና ሕሊና ስላላቸው አንዳቸው ለሌላው በወንድማማችነት መንፈስ መተያየት ይገባቸዋል።", dir: "ltr", script: "Geʻez", domain: "udhr" },
  { code: "vie", name: "Tiếng Việt", en: EN, text: "Mọi người sinh ra đều được tự do và bình đẳng về nhân phẩm và các quyền. Mọi người đều được phú bẩm về lý trí và lương tâm và cần phải đối xử với nhau trong tình bằng hữu.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "tha", name: "ไทย", en: EN, text: "มนุษย์ทั้งปวงเกิดมามีอิสระและเสมอภาคกันในเกียรติศักดิ์และสิทธิ ต่างมีเหตุผลและมโนธรรม และควรปฏิบัติต่อกันด้วยจิตวิญญาณแห่งภราดรภาพ", dir: "ltr", script: "Thai", domain: "udhr" },
  { code: "heb", name: "עברית", en: EN, text: "כל בני האדם נולדו בני חורין ושווים בערכם ובזכויותיהם. כולם חוננו בתבונה ובמצפון, לפיכך חובה עליהם לנהוג איש ברעהו ברוח של אחווה.", dir: "rtl", script: "Hebrew", domain: "udhr" },
  { code: "tur", name: "Türkçe", en: EN, text: "Bütün insanlar hür, haysiyet ve haklar bakımından eşit doğarlar. Akıl ve vicdana sahiptirler ve birbirlerine karşı kardeşlik zihniyeti ile hareket etmelidirler.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "fas", name: "فارسی", en: EN, text: "تمام افراد بشر آزاد به دنیا می‌آیند و از لحاظ حیثیت و کرامت و حقوق با هم برابرند. همه دارای عقل و وجدان می‌باشند و باید نسبت به یکدیگر با روح برادری رفتار کنند.", dir: "rtl", script: "Arabic", domain: "udhr" },
  { code: "urd", name: "اردو", en: EN, text: "تمام انسان آزاد اور حقوق و عزت کے اعتبار سے برابر پیدا ہوئے ہیں۔ انہیں ضمیر اور عقل ودیعت ہوئی ہے اس لئے انہیں ایک دوسرے کے ساتھ بھائی چارے کا سلوک کرنا چاہئے۔", dir: "rtl", script: "Arabic", domain: "udhr" },
  { code: "ind", name: "Bahasa Indonesia", en: EN, text: "Semua orang dilahirkan merdeka dan mempunyai martabat dan hak-hak yang sama. Mereka dikaruniai akal dan hati nurani dan hendaknya bergaul satu sama lain dalam semangat persaudaraan.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "pol", name: "Polski", en: EN, text: "Wszyscy ludzie rodzą się wolni i równi pod względem swej godności i swych praw. Są oni obdarzeni rozumem i sumieniem i powinni postępować wobec innych w duchu braterstwa.", dir: "ltr", script: "Latin", domain: "udhr" },
  { code: "ell", name: "Ελληνικά", en: EN, text: "Όλοι οι άνθρωποι γεννιούνται ελεύθεροι και ίσοι στην αξιοπρέπεια και τα δικαιώματα. Είναι προικισμένοι με λογική και συνείδηση, και οφείλουν να συμπεριφέρονται μεταξύ τους με πνεύμα αδελφοσύνης.", dir: "ltr", script: "Greek", domain: "udhr" },
  { code: "kat", name: "ქართული", en: EN, text: "ყველა ადამიანი დაბადებით თავისუფალია და თანასწორი თავისი ღირსებითა და უფლებებით. მათ მინიჭებული აქვთ გონება და სინდისი და ერთმანეთის მიმართ უნდა იქცეოდნენ ძმობის სულისკვეთებით.", dir: "ltr", script: "Georgian", domain: "udhr" },
]
```

- [ ] **Step 2: Point `LanguageBlitz.tsx` (public copy) at the new data**

In `src/pages/Homepage/LanguageBlitz.tsx`, update the header comment and the import/constant:

```ts
// "Language reel": blitzes through real UDHR Article 1 renderings — accelerating,
// then decelerating onto one language, holding a beat, then blitzing again.
// Dramatizes Aquilla's core low-resource value prop: an AI first draft within
// reach for the thousands of languages that have little data and often a
// single translator. The text shown is REAL existing translation (the
// Universal Declaration of Human Rights, public domain, 500+ languages), not
// AI output — the copy frames it as the destination the AI now helps new
// communities reach fast.

import { useEffect, useRef, useState } from "react"
import { UDHR_ARTICLE1 } from "./udhr-article1.data"

const DATA = UDHR_ARTICLE1
```

- [ ] **Step 3: Add a Georgian script-detection range and update the footer tag**

In the same file, extend `SCRIPT_RANGES` (the UDHR set includes Georgian, which the eBible-era list didn't need):

```ts
const SCRIPT_RANGES: [string, RegExp][] = [
  ["Arabic", /[؀-ۿ]/g],
  ["Hebrew", /[֐-׿]/g],
  ["Devanagari", /[ऀ-ॿ]/g],
  ["Bengali", /[ঀ-৿]/g],
  ["Gurmukhi", /[਀-੿]/g],
  ["Gujarati", /[઀-૿]/g],
  ["Tamil", /[஀-௿]/g],
  ["Telugu", /[ఀ-౿]/g],
  ["Kannada", /[ಀ-೿]/g],
  ["Malayalam", /[ഀ-ൿ]/g],
  ["Thai", /[฀-๿]/g],
  ["Tibetan", /[ༀ-࿿]/g],
  ["Myanmar", /[က-႟]/g],
  ["Geʻez", /[ሀ-፿]/g],
  ["Coptic", /[Ⲁ-⳿Ϣ-ϯ]/g],
  ["Han / Kana", /[぀-ヿ一-鿿]/g],
  ["Hangul", /[가-힯]/g],
  ["Cyrillic", /[Ѐ-ӿ]/g],
  ["Georgian", /[Ⴀ-ჿ]/g],
]
```

And the reel's footer tag (was `John 3:16 · eBible corpus`):

```tsx
          <span className="aq-blitz-tag">UDHR Article 1 · public-domain translations</span>
```

- [ ] **Step 4: Manually sanity-check script detection**

Run: `pnpm test src/pages/Homepage` (runs any existing homepage tests, none currently assert script detection directly — this step is a manual grep check, not a new automated test)
Run: `node -e "console.log(require('fs').readFileSync('src/pages/Homepage/udhr-article1.data.ts','utf8').match(/code: \"\\w+\"/g).length)"`
Expected: prints `24` (one per language entry above).

- [ ] **Step 5: Commit**

```bash
git add src/pages/Homepage/udhr-article1.data.ts src/pages/Homepage/LanguageBlitz.tsx
git commit -m "feat(homepage): swap public homepage's language demo from eBible/John 3:16 to UDHR Article 1"
```

---

### Task 4: Genericize `MultimodalWorkspace.tsx` (public homepage centerpiece)

**Files:**
- Modify: `src/pages/Homepage/MultimodalWorkspace.tsx` (public copy only — `MultimodalWorkspaceBT.tsx` from Task 1 is untouched)

**Interfaces:**
- Consumes: nothing new.
- Produces: same `MultimodalWorkspace({ theme })` export signature as before — content-only changes.

- [ ] **Step 1: Replace the `VERSE` constant with a generic reference sentence**

```ts
const VERSE = {
  ref: "Sample 1.1",
  sourceLang: "English · source",
  source:
    "Every voice deserves to be heard in its own language.",
  targetLang: "Spanish · draft",
  targetTag: "es",
  target:
    "Cada voz merece ser escuchada en su propio idioma.",
}
```

- [ ] **Step 2: Update `MODE_NOTE` to drop Scripture/verse framing**

```ts
const MODE_NOTE: Record<Mode, React.ReactNode> = {
  text: <>One line, written. <span className="aq-mono">live rules + back-translation as you type.</span></>,
  audio: <>The same line, spoken. <span className="aq-mono">record oral renderings, line by line.</span></>,
  video: <>The same line, captioned. <span className="aq-mono">subtitles and dubs synced to video playback.</span></>,
  image: <>The same line, on an image. <span className="aq-mono">coming soon — caption overlays for graphics and slides.</span></>,
  story: <>The same line, retold. <span className="aq-mono">coming soon — oral-first story panels for listening communities.</span></>,
}
```

- [ ] **Step 3: Update the `AudioPanel` rows (verse refs → line refs, no verse-numbering)**

```ts
function AudioPanel({ theme }: { theme: "light" | "dark" }) {
  const rows = [
    { ref: "1.1", dur: "0:12", health: 91, seed: "cada voz merece ser escuchada", rec: false },
    { ref: "1.2", dur: "0:09", health: 78, seed: "en su propio idioma", rec: false },
    { ref: "1.3", dur: "—", health: 0, seed: "hoy mismo en cualquier idioma", rec: true },
  ]
```

And its footer copy — replace the Scripture-specific line:

```tsx
      <p style={{ marginTop: 16, fontSize: 13.5, color: "var(--aq-faint)", lineHeight: 1.5 }}>
        Text and audio live in the same cell. Edit the words, and the recording is right there beside them — for communities where audio comes first, before text.
      </p>
```

- [ ] **Step 4: Update `VideoPanel`'s caption cues and footer copy**

```ts
function VideoPanel() {
  const cues = [
    "Cada voz merece ser escuchada",
    "en su propio idioma —",
    "hoy mismo, en cualquier medio.",
  ]
```

Remove the `SWARM-TODO(homepage-copy)` comment and JESUS Film reference, replacing the footer paragraph:

```tsx
      <p style={{ marginTop: 16, fontSize: 13.5, color: "var(--aq-faint)", lineHeight: 1.5 }}>
        Training videos, lectures, scripted content — caption and dub them against the same source text and the same project memory, with timings that stay in sync.
      </p>
```

- [ ] **Step 5: Update `ImagePanel`'s language samples and copy**

```ts
function ImagePanel() {
  const langs = [
    { tag: "ES", text: "Cada voz merece ser escuchada…" },
    { tag: "FR", text: "Chaque voix mérite d'être entendue…" },
    { tag: "EN", text: "Every voice deserves to be heard…" },
  ]
```

```tsx
          <p style={{ marginTop: 12, fontSize: 14.5, color: "var(--aq-dim)", lineHeight: 1.55 }}>
            Translate caption overlays for quote cards, marketing graphics, and lesson slides. This mode is exploratory — shape it early by sharing your use case.
          </p>
```

- [ ] **Step 6: Update `StoryPanel`'s panels (unrelated to the creation narrative)**

```ts
function StoryPanel() {
  const panels = [
    { n: 1, art: <StoryGlobe />, cap: "Todos tienen algo que decir." },
    { n: 2, art: <StoryGift />, cap: "Pero no siempre en el idioma correcto." },
    { n: 3, art: <StoryDawn />, cap: "Ahora, cada voz puede llegar más lejos." },
  ]
```

- [ ] **Step 7: Run the build to confirm no TypeScript/JSX errors**

Run: `pnpm build`
Expected: succeeds (same three-plus HTML entries as Task 2's Step 8).

- [ ] **Step 8: Commit**

```bash
git add src/pages/Homepage/MultimodalWorkspace.tsx
git commit -m "feat(homepage): genericize public homepage's interactive demo content"
```

---

### Task 5: Genericize `Homepage.tsx` copy (public homepage)

**Files:**
- Modify: `src/pages/Homepage/Homepage.tsx` (public copy only — `BibleTranslationLanding.tsx` from Task 1 is untouched)
- Modify: `homepage.html` (static pre-mount hero fallback only — `bible-translation.html` from Task 2 is untouched)

**Interfaces:**
- Consumes: `MultimodalWorkspace` (genericized in Task 4), `LanguageBlitz`/`LanguageMarquee` (genericized in Task 3) — same import paths as before (`./MultimodalWorkspace`, `./LanguageBlitz`), unchanged.
- Produces: same `Homepage()` export signature — content-only changes.

- [ ] **Step 1: Hero section**

Replace lines 87-96:

```tsx
          <div className="aq-hero-eyebrow aq-load aq-d1">
            <span className="aq-dot" aria-hidden="true" /> One workspace for text, audio &amp; video translation
          </div>
          <h1 className="aq-display aq-load aq-d2">
            Translators, <span className="aq-gold-text aq-display-italic">lifted.</span>
          </h1>
          <p className="aq-hero-sub aq-load aq-d3">
            The first workspace where <b style={{ color: "var(--aq-text)" }}>text and audio</b> translation
            live under one roof — with caption and subtitle translation for video coming soon. Real-time guidance and a memory
            that learns — so every language reaches every medium it's heard, read, and watched in.
          </p>
```

- [ ] **Step 2: Trust band**

Replace lines 120-133 (drop the ETEN/All-Access chip row, replace with a line consistent with the case study kept below):

```tsx
        {/* ── Trust band ──────────────────────────────────────────────── */}
        <section className="aq-container" style={{ paddingBottom: 24 }}>
          <div className="aq-reveal" style={{ textAlign: "center" }}>
            <p style={{ fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--aq-faint)" }}>
              Proven in some of the highest-stakes, lowest-resource translation there is
            </p>
            <div style={{ display: "flex", gap: 32, justifyContent: "center", flexWrap: "wrap", marginTop: 20, color: "var(--aq-dim)", fontWeight: 540, fontSize: 17 }}>
              <span>Come&nbsp;and&nbsp;See</span>
              <span style={{ opacity: 0.3 }}>·</span>
              <span>125 languages, 2× Guinness World Record</span>
            </div>
          </div>
        </section>
```

- [ ] **Step 3: Multimodal manifesto section**

Replace lines 138-144:

```tsx
            <span className="aq-eyebrow">The future is multimodal</span>
            <h2 className="aq-display">Most of the world meets language by listening, not reading.</h2>
            <p>
              For too long, tools forced a choice between the written word and the spoken one. Aquilla refuses it.
              Translate text and audio today, with captions and subtitles for video coming soon — all drafted against one source,
              held to one project's voice, kept in sync as it grows.
            </p>
```

- [ ] **Step 4: Language-blitz intro**

Replace lines 172-178:

```tsx
            <span className="aq-eyebrow">Low-resource? Still in reach.</span>
            <h2 className="aq-display">A first draft in seconds — even in languages most tools have never seen.</h2>
            <p>
              Aquilla brings real AI assistance to the long tail: the thousands of languages with little data and,
              often, a single translator. Here is the UDHR's opening line across the world's tongues — the kind
              of head start now within reach for the languages still waiting.
            </p>
```

- [ ] **Step 5: Living Memory demo panel label**

Replace line 215 (`Luke 15:13 · draft`):

```tsx
              <div style={{ fontSize: 12.5, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--aq-faint)", marginBottom: 14 }}>Doc 4.2 · draft</div>
```

- [ ] **Step 6: Quality feature demo data**

Replace the `aq-health-grid` and "Biggest drags" arrays (lines 257-261 and 274-277):

```tsx
                {[
                  { l: "Doc 3", s: "fully validated", h: 96 },
                  { l: "Doc 5.2", s: "needs a look", h: 58 },
                  { l: "Doc 1", s: "in progress", h: 81 },
                  { l: "Doc 4", s: "drafting", h: 34 },
                ].map((c) => (
```

```tsx
                {[
                  { ref: "Doc 4.6", h: 34 },
                  { ref: "Doc 5.2 · 5", h: 52 },
                ].map((d) => (
```

- [ ] **Step 7: Proof section — relabel, drop Bible/Scripture words, swap the pull-quote**

Replace lines 368-379 (keep the org name, show name, and stats verbatim; the direct Barnett quote is replaced with a stat-focused line since it can't be reworded without misattributing him):

```tsx
              <span className="aq-eyebrow">Come and See Foundation</span>
              <h3 className="aq-display" style={{ marginTop: 14 }}>125 languages. A Guinness World Record. Twice.</h3>
              <p>
                Come and See is translating <em>The Chosen</em> into 600 languages to reach 95% of the world.
                With experts steering and the system carrying consistency and in-flow review, they reached
                125 languages — including 39 low-resource languages a subject-matter expert could finally
                carry — reaching communities that would otherwise still be waiting for a team to free up.
              </p>
              <blockquote className="aq-quote aq-display" style={{ marginTop: 26, color: "var(--aq-text)" }}>
                125 languages reached. Two Guinness World Records. One workspace.
              </blockquote>
              <a href="/case-studies/come-and-see" className="aq-btn aq-btn-ghost aq-btn-sm" style={{ marginTop: 24 }}>
                Read the full story <IconArrow />
              </a>
```

(this also removes the `<div className="aq-quote-cite">` line entirely, since the replacement isn't attributed to a person)

- [ ] **Step 8: Pricing section**

Replace lines 406-436 in full:

```tsx
          <div className="aq-head aq-center aq-reveal" style={{ marginBottom: 44 }}>
            <span className="aq-eyebrow">Access</span>
            <h2 className="aq-display">Free to start. Simple when you scale.</h2>
            <p>Aquilla is free for everyone today. No payment is collected on this site yet — usage-based pricing is coming, and we'll tell you before anything changes.</p>
          </div>
          <div className="aq-price-grid aq-reveal" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            <div className="aq-price">
              <h4 className="aq-display">Everyone</h4>
              <div className="aq-price-tag">Free, forever</div>
              <p>The whole workspace — no credit card, no trial clock. For every translator and team.</p>
              <ul>
                <li><IconCheck /> Full workspace — text and audio translation</li>
                <li><IconCheck /> Real-time guidance &amp; back-translation</li>
                <li><IconCheck /> Cloud sync &amp; team collaboration</li>
                <li><IconCheck /> On-device speech</li>
              </ul>
              <a href="/onboarding" className="aq-btn aq-btn-gold">Sign up free</a>
            </div>
            <div className="aq-price">
              <span className="aq-chip" style={{ position: "absolute", top: 20, right: 20 }}>Coming soon</span>
              <h4 className="aq-display">Pro</h4>
              <div className="aq-price-tag">$45 / project / month</div>
              <p>For elevated AI usage beyond the free cap. Pay-as-you-go for usage over that — not live yet, and nothing is billed today.</p>
              <ul>
                <li><IconCheck /> Everything in Everyone</li>
                <li><IconCheck /> Higher AI usage caps per project</li>
                <li><IconCheck /> Pay-as-you-go for usage above the cap</li>
              </ul>
              <a href="mailto:hello@aquilla.app?subject=Pro%20waitlist" className="aq-btn aq-btn-ghost">Join the waitlist</a>
            </div>
            <div className="aq-price" data-feature="true">
              <h4 className="aq-display">Enterprise support</h4>
              <div className="aq-price-tag">Talk to us</div>
              <p>Running translation at scale or need dedicated help? We're happy to support you directly.</p>
              <ul>
                <li><IconCheck /> Dedicated onboarding &amp; direct support</li>
                <li><IconCheck /> Coordination across large programs</li>
                <li><IconCheck /> We want to see you succeed</li>
              </ul>
              <a href="mailto:hello@aquilla.app" className="aq-btn aq-btn-ghost">Talk to us</a>
            </div>
          </div>
```

- [ ] **Step 9: Final CTA + footer**

Replace line 443:

```tsx
            <p>Open your source text, draft in any medium, and let the system steer alongside you. Start today — it's free.</p>
```

Replace line 458:

```tsx
              <p>{brand.app.tagline} A multimodal translation workspace for every language still waiting.</p>
```

Replace line 467 (case-study footer link — unchanged path, just confirming it stays since the case study is kept):

```tsx
                <a href="/case-studies/come-and-see">Case study</a>
```

Replace line 479 (drop the All-Access Goals line entirely — delete the `<span>Made for the All-Access Goals — Scripture for every language by 2033.</span>` line so `aq-footer-base` has only the copyright `<span>`).

- [ ] **Step 10: Update the existing login-link test's mocked `useBrand` tagline if it asserts exact copy**

Check `src/pages/Homepage/Homepage.login-link.test.tsx` — it mocks `useBrand` with `tagline: "Tagline."` and only asserts `href` attributes, not copy text, so no change is needed here. Confirm by running it.

Run: `pnpm test src/pages/Homepage/Homepage.login-link.test.tsx`
Expected: both tests still PASS unchanged.

- [ ] **Step 11: Update `homepage.html`'s static pre-mount hero (crawler/no-JS fallback)**

`homepage.html` (not `Homepage.tsx`) has its own static pre-hydration hero markup shown to crawlers, no-JS visitors, and briefly before React mounts — it currently duplicates the old Bible-oriented copy. Task 2 copied this file verbatim into `bible-translation.html` for the BT page (correct — that page should keep the Bible copy), but the original `homepage.html` also needs the generic rewrite. Replace its pre-mount `<p>` (currently "One workspace for Bible &amp; ministry translation — text, audio, and video under one roof, with real-time guidance and a memory that learns. Free for everyone."):

```html
        <p>
          One workspace for text, audio, and video translation — under one roof, with
          real-time guidance and a memory that learns. Free for everyone.
        </p>
```

The `<h1>Translation, <em>lifted.</em></h1>` line and the `Create account`/`Sign in` actions stay unchanged.

- [ ] **Step 12: Build and manually verify in the dev preview**

Run: `pnpm build`
Expected: succeeds.

Start the dev stack, navigate to `/homepage` and `/bible-translation`, and confirm:
- `/homepage` shows the new generic hero/pricing/proof copy with no "Bible"/"Scripture"/"ministry"/"church" wording, and the language-blitz reel cycles through the UDHR entries.
- `/bible-translation` renders byte-identical to the old homepage (Scripture hero, John 3:16 demo, old pricing/footer copy).
- View source on `/bible-translation` and confirm `<meta name="robots" content="noindex, nofollow">` is present.
- Confirm no link anywhere in `/homepage`'s nav or footer points to `/bible-translation`.

- [ ] **Step 13: Commit**

```bash
git add src/pages/Homepage/Homepage.tsx
git commit -m "feat(homepage): rewrite public homepage copy to drop Bible/ministry framing"
```

---

## Self-Review Notes

- **Spec coverage:** Architecture (Task 1+2), generic copy rewrite — hero/trust/manifesto/language-blitz/feature labels/proof/pricing/footer (Task 5), demo content — MultimodalWorkspace + LanguageBlitz/UDHR (Tasks 3-4), noindex + robots.txt + Worker route (Task 2), testing (Tasks 1, 2, 5 each run/update relevant tests) — all spec sections have a task.
- **Placeholder scan:** no TBD/TODO left; the one flagged uncertainty (Amharic/Georgian translation accuracy) is called out explicitly in code comments rather than hidden, matching the existing "verify before launch" convention already used in this file for the Come-and-See stats.
- **Type consistency:** `SampleEntry` (Task 3) matches the shape `LanguageBlitz.tsx` already destructures (`code`, `name`, `en`, `text`, `dir`, `script`, `domain`) — same fields as `VerseEntry` in `john316.data.ts`, just renamed for the new domain. `MultimodalWorkspace({ theme })` signature is unchanged across Task 4. `BibleTranslationLanding()` / `MultimodalWorkspaceBT()` names introduced in Task 1 are used consistently in Task 1's own test file and nowhere else (Tasks 3-5 only touch the public-page originals).
