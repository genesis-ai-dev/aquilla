/**
 * English base catalog (AQU-511) — the source of truth for message keys.
 *
 * `MessageKey` is derived from this object, so every `t(key)` call is
 * type-checked and other locales are `Partial` catalogs that fall back here.
 * Keep keys namespaced (`area.thing`) and values English; translated catalogs
 * live alongside in `messages/` and only override the keys they cover.
 *
 * This file is a barrel: the strings themselves are authored one namespace at a
 * time under `../namespaces/`, alongside that namespace's context block and
 * screenshot surfaces. Add a namespace by adding its module to
 * `../namespaces/index.ts` and spreading it here.
 *
 * The modules are imported and spread individually on purpose — reducing over
 * `NAMESPACES` widens the result to `Record<string, string>`, which destroys the
 * `MessageKey` literal union every `t()` call is checked against.
 */

import { common } from "../namespaces/common"
import { nav } from "../namespaces/nav"
import { error } from "../namespaces/error"
import { language } from "../namespaces/language"

export const en = {
  ...common.keys,
  ...nav.keys,
  ...error.keys,
  ...language.keys,
} as const

export type MessageKey = keyof typeof en

/** A translated catalog: any subset of the base keys; missing keys fall back. */
export type Catalog = Partial<Record<MessageKey, string>>
