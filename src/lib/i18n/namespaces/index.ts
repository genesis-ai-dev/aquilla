/**
 * Registry of namespace modules (AQU-511 fan-out).
 *
 * `context.ts` and `screenshots.ts` are derived from this list, so a new
 * namespace's context block and surfaces land automatically once it is added
 * here.
 *
 * `messages/en.ts` is the exception and must be edited too: it imports and
 * spreads each module by hand, because reducing over `NAMESPACES` would widen
 * the result to `Record<string, string>` and destroy the `MessageKey` literal
 * union that every `t()` call is checked against. **Adding a namespace therefore
 * means editing two files, not one** — miss `messages/en.ts` and the new keys
 * silently fail to typecheck at their call sites.
 *
 * If you add a namespace that declares a screenshot surface, it also needs a
 * driver in `scripts/i18n-shots/<ns>.ts` registered in that directory's
 * `index.ts`, and a captured PNG from `pnpm i18n:shots`.
 */
import { common } from "./common"
import { nav } from "./nav"
import { error } from "./error"
import { language } from "./language"
import { dialog } from "./dialog"
import { editor } from "./editor"
import { comments } from "./comments"
import { auth } from "./auth"
import { search } from "./search"
import { audio } from "./audio"

export const NAMESPACES = [
  common,
  nav,
  error,
  language,
  dialog,
  editor,
  comments,
  auth,
  search,
  audio,
] as const
