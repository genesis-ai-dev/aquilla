import type { BibleSwapLanguageStrategy } from "./types";
import { ALL_STUDY_VOLUMES } from "./types";

/**
 * Marathi — Devanagari; Structure preserves poetry tabs and avoids English
 * speaker-label bleed (Song of Songs). NT split is MAT–JHN / ACT–REV
 * (same as Portuguese/Russian). Known sensitive boundaries (NEH 7/8, PSA
 * acrostics) are covered by the live plan and structure chapter blocks.
 */
export const marathiStrategy: BibleSwapLanguageStrategy = {
    id: "marathi",
    label: "Marathi",
    hasMappings: false,
    availableVolumes: ALL_STUDY_VOLUMES,
    preferredMode: "structure",
    forceStructureVolumes: ["JOB-SNG"],
    minUsableProjectedMatchPercent: 70,
    chapterBlockOptions: {
        retainSectionHeadings: true,
        // Keep bible speaker labels (translated); study English labels are replaced by spans.
        retainSpeakerLabels: true,
        retainAcrosticHeadings: true,
    },
    description:
        "Marathi Bible (MAT–JHN / ACT–REV). Structure recommended; JOB-SNG always uses Structure. The plan is built from the selected file.",
};
