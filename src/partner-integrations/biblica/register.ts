/**
 * Biblica integration registration (AQU-1286).
 *
 * The single entry point generic code sees for everything under this folder. Kept
 * deliberately thin — the registry loads it eagerly, so anything imported here
 * lands in the app's initial bundle. The four readers hang off `parse` thunks and
 * the panel off a `panel` thunk, so the IDML-heavy code and the UI both stay
 * code-split and load only when someone actually imports a Biblica package.
 *
 * See `docs/PARTNER-INTEGRATIONS.md`.
 */

import { BookOpen } from "lucide-react"
import type { PartnerIntegration } from "@/lib/partners/types"
import { clearBiblicaApostropheGlue } from "./apostrophe-glue"

const biblica: PartnerIntegration = {
  id: "biblica",
  importScreen: {
    titleKey: "importExport.landing.biblica.title",
    hintKey: "importExport.landing.biblica.hint",
    descriptionKey: "importExport.landing.biblica.description",
    icon: BookOpen,
    badge: "beta",
    panel: () => import("./BiblicaPanel"),
  },
  // AQU-1174: the "source serif" apostrophe glue is English typesetting in
  // Biblica's templates, not text, so it must not ride into a translation.
  idmlTargetHtmlNormalizers: [clearBiblicaApostropheGlue],
}

export default biblica
