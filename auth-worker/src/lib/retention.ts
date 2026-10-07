// Retention / active-user metrics — pure, deterministic derivations over the
// `user_activity_days` rollup (one row per user per UTC day they used the app)
// and the users table (signup date). No DB access here: the admin route and
// the emailed recap both feed rows in and format the result, so the numbers on
// the dashboard and in the inbox can never disagree.
//
// Definitions (all days are UTC calendar days, inclusive windows ending `asOf`):
//   DAU        — distinct users active on `asOf`.
//   avgDau7    — mean DAU over the 7 days ending `asOf`.
//   WAU / MAU  — distinct users active in the 7 / 30 days ending `asOf`.
//   stickiness — avgDau7 / MAU (the classic DAU/MAU ratio, smoothed so a single
//                quiet day doesn't swing it).
//   Day-N      — "unbounded" retention: of users who signed up at least N days
//                before `asOf` (within the lookback), the share active on day N
//                OR ANY LATER DAY. Chosen over exact-day retention because our
//                cohorts are small (single digits per week) and exact-day is
//                mostly noise at that size.
//   cohorts    — weekly signup cohorts (weeks start Monday). retained[k] is the
//                number of cohort members active in the k-th week after their
//                signup week (k=0 is the signup week itself). Only weeks that
//                have started by `asOf` are reported.

export interface ActivityRow {
  userId: number
  /** 'YYYY-MM-DD' (UTC). */
  day: string
}

export interface SignupRow {
  id: number
  /** 'YYYY-MM-DD' (UTC). */
  createdAt: string
}

export interface RetentionInput {
  users: SignupRow[]
  activity: ActivityRow[]
  /** 'YYYY-MM-DD' — inclusive end of every window. */
  asOf: string
  /** Length of the daily series. Default 90. */
  days?: number
  /** Number of weekly cohorts, newest last. Default 12. */
  cohortWeeks?: number
  /** Users to drop entirely (platform operators, test accounts). */
  excludeUserIds?: Iterable<number>
}

export interface DayNRetention {
  eligible: number
  retained: number
  /** retained / eligible, or null when nobody is eligible yet. */
  rate: number | null
}

export interface WeeklyCohort {
  /** Monday of the signup week, 'YYYY-MM-DD'. */
  weekStart: string
  size: number
  /** retained[k] = members active in week k after signup week (k=0 = signup week). */
  retained: number[]
}

export interface RetentionMetrics {
  asOf: string
  dau: number
  avgDau7: number
  wau: number
  mau: number
  /** avgDau7 / mau; null when MAU is 0. */
  stickiness: number | null
  newUsers7: number
  newUsers30: number
  totalUsers: number
  retention: { d1: DayNRetention; d7: DayNRetention; d30: DayNRetention }
  /** Oldest first, `days` entries ending at `asOf`; zero-filled. */
  daily: Array<{ day: string; active: number }>
  cohorts: WeeklyCohort[]
}

const MS_PER_DAY = 86_400_000
/** Only users who signed up within this many days of `asOf` enter the Day-N pools. */
const DAY_N_LOOKBACK = 365

/** Days since the Unix epoch for a 'YYYY-MM-DD' string (UTC). */
export function dayIndex(iso: string): number {
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(t)) throw new Error(`bad day: ${iso}`)
  return Math.floor(t / MS_PER_DAY)
}

/** Inverse of dayIndex. */
export function isoDay(index: number): string {
  return new Date(index * MS_PER_DAY).toISOString().slice(0, 10)
}

/** Day index of the Monday on or before `index`. (1970-01-01 was a Thursday.) */
export function weekStartIndex(index: number): number {
  // dayIndex 0 = Thursday → weekday = (index + 3) % 7 gives Monday = 0.
  const weekday = (((index + 3) % 7) + 7) % 7
  return index - weekday
}

export function computeRetention(input: RetentionInput): RetentionMetrics {
  const days = input.days ?? 90
  const cohortWeeks = input.cohortWeeks ?? 12
  const asOf = dayIndex(input.asOf)
  const excluded = new Set(input.excludeUserIds ?? [])

  const signup = new Map<number, number>()
  for (const u of input.users) {
    if (excluded.has(u.id)) continue
    signup.set(u.id, dayIndex(u.createdAt))
  }

  // user → sorted set of active day indexes (dedup: the rollup is already
  // unique per (user, day), but be safe against a stitched backfill).
  const activeDays = new Map<number, Set<number>>()
  const activeByDay = new Map<number, Set<number>>()
  for (const a of input.activity) {
    if (excluded.has(a.userId) || !signup.has(a.userId)) continue
    const d = dayIndex(a.day)
    if (d > asOf) continue
    let set = activeDays.get(a.userId)
    if (!set) activeDays.set(a.userId, (set = new Set()))
    set.add(d)
    let users = activeByDay.get(d)
    if (!users) activeByDay.set(d, (users = new Set()))
    users.add(a.userId)
  }

  const distinctActiveIn = (from: number, to: number): number => {
    const seen = new Set<number>()
    for (let d = from; d <= to; d++) for (const u of activeByDay.get(d) ?? []) seen.add(u)
    return seen.size
  }

  const daily: RetentionMetrics["daily"] = []
  for (let d = asOf - days + 1; d <= asOf; d++) {
    daily.push({ day: isoDay(d), active: activeByDay.get(d)?.size ?? 0 })
  }

  const dau = activeByDay.get(asOf)?.size ?? 0
  let sum7 = 0
  for (let d = asOf - 6; d <= asOf; d++) sum7 += activeByDay.get(d)?.size ?? 0
  const avgDau7 = sum7 / 7
  const wau = distinctActiveIn(asOf - 6, asOf)
  const mau = distinctActiveIn(asOf - 29, asOf)

  const signupsIn = (from: number, to: number): number => {
    let n = 0
    for (const s of signup.values()) if (s >= from && s <= to) n++
    return n
  }

  const dayN = (n: number): DayNRetention => {
    let eligible = 0
    let retained = 0
    for (const [id, s] of signup) {
      if (s + n > asOf || s < asOf - DAY_N_LOOKBACK) continue
      eligible++
      const set = activeDays.get(id)
      if (!set) continue
      for (const d of set) {
        if (d >= s + n) {
          retained++
          break
        }
      }
    }
    return { eligible, retained, rate: eligible > 0 ? retained / eligible : null }
  }

  const cohorts: WeeklyCohort[] = []
  const currentWeek = weekStartIndex(asOf)
  for (let w = cohortWeeks - 1; w >= 0; w--) {
    const start = currentWeek - 7 * w
    const members: number[] = []
    for (const [id, s] of signup) if (s >= start && s < start + 7) members.push(id)
    const weeksStarted = w + 1 // weeks from `start` up to and including the current week
    const retained: number[] = []
    for (let k = 0; k < weeksStarted; k++) {
      const from = start + 7 * k
      const to = from + 6
      let n = 0
      for (const id of members) {
        const set = activeDays.get(id)
        if (!set) continue
        for (const d of set) {
          if (d >= from && d <= to) {
            n++
            break
          }
        }
      }
      retained.push(n)
    }
    cohorts.push({ weekStart: isoDay(start), size: members.length, retained })
  }

  return {
    asOf: isoDay(asOf),
    dau,
    avgDau7,
    wau,
    mau,
    stickiness: mau > 0 ? avgDau7 / mau : null,
    newUsers7: signupsIn(asOf - 6, asOf),
    newUsers30: signupsIn(asOf - 29, asOf),
    totalUsers: signup.size,
    retention: { d1: dayN(1), d7: dayN(7), d30: dayN(30) },
    daily,
    cohorts,
  }
}
