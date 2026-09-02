import { lazy } from "react"
import { BookOpen } from "lucide-react"
import type { PartnerImportSource } from "../types"

export const biblicaSource: PartnerImportSource = {
  id: "biblica",
  titleKey: "importExport.landing.biblica.title",
  hintKey: "importExport.landing.biblica.hint",
  descriptionKey: "importExport.landing.biblica.description",
  icon: BookOpen,
  badge: "beta",
  // Lazy: the biblica import module (and its @/lib/import deps) load only when
  // the panel is actually shown, keeping it out of the dialog's eager graph.
  Panel: lazy(() => import("./BiblicaPanel").then((m) => ({ default: m.BiblicaPanel }))),
}
