/**
 * Registry of namespace modules (AQU-511 fan-out).
 *
 * Adding a namespace means adding its module here — the three registries
 * (`messages/en.ts`, `context.ts`, `screenshots.ts`) are all derived from this
 * list, so there is exactly one place to touch.
 */
import { common } from "./common"
import { nav } from "./nav"
import { error } from "./error"
import { language } from "./language"

export const NAMESPACES = [common, nav, error, language] as const
