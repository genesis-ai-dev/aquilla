// "Language reel": blitzes through real John 3:16 renderings from the eBible
// corpus — accelerating, then decelerating onto one language, holding a beat,
// then blitzing again. Dramatizes Aquilla's core low-resource value prop:
// an AI first draft within reach for the thousands of languages that have
// little data and often a single translator. The verses shown are REAL
// existing translations (open eBible corpus), not AI output — the copy frames
// them as the destination the AI now helps new communities reach fast.

import { useEffect, useRef, useState } from "react"
import { JOHN_316 } from "./john316.data"

const DATA = JOHN_316
// Ease-in-out reel: starts quick, peaks, then slows into the landing.
const BLITZ_DELAYS = [120, 80, 60, 52, 50, 52, 58, 70, 92, 124, 168, 224, 290]
const HOLD_MS = 2200

function pick(prev: number) {
  if (DATA.length < 2) return 0
  let n = prev
  while (n === prev) n = Math.floor(Math.random() * DATA.length)
  return n
}

// eBible's script metadata is occasionally wrong (e.g. Devanagari text tagged
// "Latin"), so derive the tag from the glyphs actually present instead.
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
]

function detectScript(text: string): string {
  let best = "Latin"
  let bestN = 0
  for (const [name, re] of SCRIPT_RANGES) {
    const n = (text.match(re) || []).length
    if (n > bestN) { bestN = n; best = name }
  }
  return best
}

export function LanguageBlitz() {
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * DATA.length))
  const [phase, setPhase] = useState<"blitz" | "settle">("blitz")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    let cancelled = false
    let cur = idx

    const clear = () => { if (timer.current) clearTimeout(timer.current) }

    if (reduce) {
      const slow = () => {
        if (cancelled) return
        cur = pick(cur); setIdx(cur); setPhase("settle")
        timer.current = setTimeout(slow, 3200)
      }
      timer.current = setTimeout(slow, 3200)
      return () => { cancelled = true; clear() }
    }

    const runBlitz = () => {
      let step = 0
      const stepFn = () => {
        if (cancelled) return
        setPhase("blitz")
        cur = pick(cur); setIdx(cur)
        step++
        if (step < BLITZ_DELAYS.length) {
          timer.current = setTimeout(stepFn, BLITZ_DELAYS[step])
        } else {
          cur = pick(cur); setIdx(cur)
          setPhase("settle")
          timer.current = setTimeout(runBlitz, HOLD_MS)
        }
      }
      stepFn()
    }
    // brief beat before the first reel so the section can settle into view
    timer.current = setTimeout(runBlitz, 600)
    return () => { cancelled = true; clear() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const e = DATA[idx]

  return (
    <div className="aq-blitz" data-phase={phase}>
      <div className="aq-blitz-top">
        <span className="aq-blitz-live"><i /> Drafting across the world's languages</span>
        <span className="aq-blitz-counter"><span className="aq-mono">{DATA.length}</span> of 7,000+</span>
      </div>

      <div className="aq-blitz-stage">
        <div className="aq-blitz-scan" />

        {/* key=idx remounts so the tick/settle animation replays each change */}
        <div className="aq-blitz-roll" key={idx}>
          <div className="aq-blitz-head">
            <span className="aq-blitz-name aq-display" dir={e.dir}>{e.name}</span>
            <span className="aq-blitz-meta">
              <span className="aq-blitz-code">{e.code}</span>
              <span className="aq-blitz-script">{detectScript(e.text)}{e.dir === "rtl" ? " · RTL" : ""}</span>
            </span>
          </div>
          <p className="aq-blitz-verse" dir={e.dir} lang={e.code}>{e.text}</p>
        </div>

        <div className="aq-blitz-foot">
          {phase === "blitz" ? (
            <span className="aq-blitz-status">
              <span className="aq-blitz-dotwave"><i /><i /><i /></span>
              scanning renderings…
            </span>
          ) : (
            <span className="aq-blitz-ready">
              <IconCheckRing /> first-draft target ready
            </span>
          )}
          <span className="aq-blitz-tag">John 3:16 · eBible corpus</span>
        </div>
      </div>
    </div>
  )
}

/* Marquee of every language name — reinforces the breadth. */
export function LanguageMarquee() {
  const names = DATA.map((d) => d.en)
  const loop = [...names, ...names]
  return (
    <div className="aq-marquee" aria-hidden>
      <div className="aq-marquee-track">
        {loop.map((n, i) => (
          <span className="aq-marquee-item" key={i}>{n}</span>
        ))}
      </div>
    </div>
  )
}

function IconCheckRing() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6.2" opacity="0.5" />
      <path d="M5 8.2l2 2 4-4.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
