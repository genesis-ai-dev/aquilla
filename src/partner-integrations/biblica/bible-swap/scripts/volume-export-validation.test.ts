/**
 * Scores a whole study volume the way the external Biblica validation app does,
 * against the Bible the export actually reads.
 *
 * The per-function suites all passed while a real GEN-DEU export scored 79%:
 * the quotation-dash fix (`normalizeBibleStoryXmlGlyphs`) rewrites every line of
 * dialogue on its way into the study Bible, so scoring the result against the
 * untouched Bible file reported all ~1,200 dialogue verses as wrong text.
 * Nothing below the full-volume level could see that, because nothing below it
 * ran the normalization and the comparison together.
 */
import { describe, it, expect } from "vitest";
import {
    issueKey,
    languageFixture,
    summarizeIssues,
    swapAndValidateVolume,
    volumeFilesExist,
    type VolumePair,
} from "./bibleSwapValidation";

const LANGUAGE = "portuguese";

/**
 * Verses the swap is known to land imperfectly, verified byte-for-byte against
 * the codex engine — these are not an Aquilla regression. In both, a
 * whitespace-only CharacterStyleRange separating the speech colon from the
 * dialogue dash ("voz:\t— Até quando") is dropped on the way in. Fixing it is a
 * deliberate divergence from codex, so it is pinned here rather than ignored:
 * any new mismatch fails, and so does fixing these without updating this list.
 */
const KNOWN_MISMATCHES: Record<string, readonly string[]> = {
    "ACT-REV": ["REV 6:10", "REV 9:14"],
};

/** The volumes whose Bibles are present on this machine. */
const volumes: VolumePair[] = languageFixture(LANGUAGE).volumes.filter((pair) =>
    volumeFilesExist(pair, LANGUAGE)
);

describe.skipIf(volumes.length === 0)(
    `${LANGUAGE} volume export validation`,
    () => {
        it.each(volumes)(
            "$volume swaps every verse the validator can match",
            async (pair) => {
                const { analysis } = await swapAndValidateVolume(pair, LANGUAGE);

                expect(analysis.verseCounts.export).toBeGreaterThan(0);
                expect(
                    analysis.issues.map(issueKey).sort(),
                    `${pair.volume} issues:\n${summarizeIssues(analysis)}`
                ).toEqual([...(KNOWN_MISMATCHES[pair.volume] ?? [])].sort());
            },
            600000
        );
    }
);
