import type { BibleSwapLanguageStrategy } from "./types";
import { ALL_STUDY_VOLUMES } from "./types";

/**
 * Ukrainian — the plan is built from the selected Bible file, same as every
 * other language. Chapter blocks keep section, speaker, and acrostic headings.
 */
export const ukrainianStrategy: BibleSwapLanguageStrategy = {
    id: "ukrainian",
    label: "Ukrainian",
    hasMappings: false,
    availableVolumes: ALL_STUDY_VOLUMES,
    preferredMode: "structure",
    minUsableProjectedMatchPercent: 50,
    chapterBlockOptions: {
        retainSectionHeadings: true,
        retainSpeakerLabels: true,
        retainAcrosticHeadings: true,
    },
    description:
        "Ukrainian Bible. Structure recommended. The plan is built from the selected file.",
};
