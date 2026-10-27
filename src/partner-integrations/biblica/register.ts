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
import { isBiblicaScriptureCell } from "./cell-kind"
import {
  BIBLICA_NOTES_PROFILE_ID,
  EBL_PROFILE_ID,
  REACH4LIFE_PROFILE_ID,
  TREASURE_HUNT_PROFILE_ID,
} from "./editions"
import { applyBiblicaProtectedHtmlReflow } from "./export-reflow"

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
  // The reflow after it moves leftover English out of slots a translation
  // did not fill, which is what lets a study-Bible package round-trip.
  idmlTargetHtmlNormalizers: [clearBiblicaApostropheGlue, applyBiblicaProtectedHtmlReflow],
  idmlExportOptions: [
    {
      id: "bible-swap",
      profileIds: [BIBLICA_NOTES_PROFILE_ID, TREASURE_HUNT_PROFILE_ID],
      panel: () => import("./bible-swap/ExportOption"),
    },
  ],
  // AQU-1285: a study-Bible volume carries its verses as cells next to the
  // notes; the editor marks those rows through this hook.
  isScriptureCell: isBiblicaScriptureCell,
  // Repair has to cut cells the way a normal Biblica import does. The editions
  // stay behind this thunk so the four readers are not in the initial bundle.
  idmlImportEditions: () => import("./editions").then((mod) => Object.values(mod.BIBLICA_EDITIONS)),
  importProfileIds: [
    BIBLICA_NOTES_PROFILE_ID,
    TREASURE_HUNT_PROFILE_ID,
    REACH4LIFE_PROFILE_ID,
    EBL_PROFILE_ID,
  ],
  importCorpusMarkers: [
    "Biblica Study Notes",
    "Treasure Hunt Bible",
    "Reach 4 Life",
    "Equipping Biblical Leaders",
  ],
}

export default biblica
