/**
 * Per-language Bible Swap strategy.
 *
 * The verse alignment is built from the selected Bible file at export time.
 * Strategies layer language-specific swap behaviour on top: preferred mode,
 * volumes that must use Structure, chapter-block indexing flags, and optional
 * plan refinements.
 */

import type { BuildChapterBlockOptions } from "../../chapterBlocks";
import type { BibleSwapMode } from "../../types";
import type { VersificationPlan } from "../../versificationPlan";

export type BibleSwapMappedLanguageId =
    | "portuguese"
    | "russian"
    | "french"
    | "hindi"
    | "marathi"
    | "arabic"
    | "ukrainian";

export type BibleSwapLanguageId = "any" | BibleSwapMappedLanguageId;

export const ALL_STUDY_VOLUMES = [
    "GEN-DEU",
    "JOS-EST",
    "JOB-SNG",
    "ISA-MAL",
    "MAT-JOHN",
    "ACT-REV",
] as const;

export type StudyVolumeId = (typeof ALL_STUDY_VOLUMES)[number];

export interface BibleSwapLanguageStrategy {
    id: BibleSwapLanguageId;
    label: string;
    /**
     * No language ships a stored plan. Kept so older callers can still ask;
     * export always derives the plan from the selected Bible file.
     */
    hasMappings: boolean;
    /** Volumes this strategy is written for. */
    availableVolumes: readonly StudyVolumeId[];
    /** Volumes whose stored plans were rejected. Unused now that plans are built live. */
    unusableVolumes?: readonly StudyVolumeId[];
    /**
     * Default mode suggestion for the UI. "auto" leaves Surgical/Structure
     * to the user; strategies may still force structure for specific volumes.
     */
    preferredMode: BibleSwapMode | "auto";
    /** Volumes that always run structure swap (heavy versification deltas). */
    forceStructureVolumes?: readonly StudyVolumeId[];
    /**
     * Floor kept for the usability check on a caller-supplied plan. Export does
     * not load a stored plan, so this no longer gates a swap.
     */
    minUsableProjectedMatchPercent: number;
    /** Chapter-block build overrides when indexing the Bible for structure swap. */
    chapterBlockOptions?: BuildChapterBlockOptions;
    /** Short note shown under the language pill in the export UI. */
    description: string;
    /**
     * Optional plan refinement after deserialization (language-specific
     * post-processing). Default is identity.
     */
    refinePlan?: (plan: VersificationPlan, volume: string) => VersificationPlan;
}

export function resolveSwapModeForLanguage(
    strategy: BibleSwapLanguageStrategy,
    volume: string,
    userMode: BibleSwapMode
): BibleSwapMode {
    if (strategy.forceStructureVolumes?.includes(volume as StudyVolumeId)) {
        return "structure";
    }
    if (strategy.preferredMode === "surgical" || strategy.preferredMode === "structure") {
        // User selection still wins unless volume is force-structure.
        return userMode;
    }
    return userMode;
}
