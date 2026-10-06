/**
 * Language strategies and deserialization of a versification plan. Plans are
 * built from the selected Bible file at export time; nothing here reads a
 * stored mapping file.
 */

import { describe, expect, it } from "vitest";
import {
    ANY_BIBLE_SWAP_LANGUAGE,
    BIBLE_SWAP_LANGUAGES,
    applyLanguagePlanRefinements,
    deserializeVersificationPlan,
    getBibleSwapLanguageStrategy,
    isMappedBibleSwapLanguage,
    resolveSwapModeForLanguage,
    studyVolumeFromFileName,
    type SerializedVersificationPlan,
} from "../language-mappings";
import { chapterBlockKey, verseKey } from "../types";
import type { VersificationPlan } from "../versificationPlan";

const EMPTY_STATS: SerializedVersificationPlan["stats"] = {
    versesMapped: 1,
    versesRemoved: 1,
    versesInserted: 0,
    psalmChapterSlots: 0,
    psalmChapterShifts: 0,
};

function samplePlan(): SerializedVersificationPlan {
    return {
        verseMappings: [
            {
                study: { book: "JOS", chapter: "1", verse: "1", key: verseKey("JOS", "1", "1") },
                action: "replace",
                bible: { book: "JOS", chapter: "1", verse: "1" },
            },
            {
                study: { book: "JOS", chapter: "1", verse: "2", key: verseKey("JOS", "1", "2") },
                action: "remove",
            },
        ],
        chapterRemaps: [{ book: "JOS", studyChapter: "1", bibleChapter: "1" }],
        chapterInserts: [
            {
                book: "RUT",
                studyChapter: "4",
                verses: [{ bibleChapter: "4", bibleVerse: "22" }],
            },
        ],
        structureChapters: [
            {
                book: "JOS",
                studyChapter: "1",
                studyVerseStart: 1,
                studyVerseEnd: 18,
                insertOnly: false,
                bibleSlices: [{ chapter: "1", firstVerse: 1, lastVerse: 18 }],
            },
        ],
        trailingInserts: [],
        stats: EMPTY_STATS,
    };
}

function emptyRuntimePlan(): VersificationPlan {
    return {
        verseMap: new Map(),
        structureChapters: new Map(),
        chapterInserts: new Map(),
        trailingInserts: [],
        chapterRemaps: new Map(),
        stats: {
            versesMapped: 0,
            versesRemoved: 0,
            versesInserted: 0,
            psalmChapterSlots: 0,
            psalmChapterShifts: 0,
        },
    };
}

describe("language registry", () => {
    it("offers Any plus every language, and none of them ship a stored plan", () => {
        const ids = BIBLE_SWAP_LANGUAGES.map((l) => l.id);
        expect(ids).toEqual([
            ANY_BIBLE_SWAP_LANGUAGE,
            "portuguese",
            "russian",
            "french",
            "hindi",
            "marathi",
            "arabic",
            "ukrainian",
        ]);
        for (const language of ids) {
            expect(isMappedBibleSwapLanguage(language), language).toBe(false);
            expect(getBibleSwapLanguageStrategy(language).hasMappings).toBe(false);
        }
    });

    it("derives study volume from file names", () => {
        expect(studyVolumeFromFileName("JOS-EST.idml")).toBe("JOS-EST");
        expect(studyVolumeFromFileName("jos-est.codex")).toBe("JOS-EST");
        expect(studyVolumeFromFileName("C:\\files\\MAT-JOHN.idml")).toBe("MAT-JOHN");
        expect(studyVolumeFromFileName("GEN-DEU.idml")).toBe("GEN-DEU");
    });

    it("strips importer tags, notebook uuids, and dedup counters", () => {
        expect(studyVolumeFromFileName("JOS-EST-biblica.idml")).toBe("JOS-EST");
        expect(studyVolumeFromFileName("GEN-DEU-biblica.idml")).toBe("GEN-DEU");
        expect(studyVolumeFromFileName("mat-john-biblica.idml")).toBe("MAT-JOHN");
        expect(studyVolumeFromFileName("JOB-SNG (1).idml")).toBe("JOB-SNG");
        expect(studyVolumeFromFileName("MAT-JOHN (1).idml")).toBe("MAT-JOHN");
        expect(studyVolumeFromFileName("JOS-EST-notes.codex")).toBe("JOS-EST");
        expect(
            studyVolumeFromFileName("ISA-MAL-313c6d48-60a1-43c3-bf02-5ac01575c5d1.codex")
        ).toBe("ISA-MAL");
        expect(
            studyVolumeFromFileName("MAT-JOHN-1-babcfc68-c64f-4052-85aa-8c8391924f9b.codex")
        ).toBe("MAT-JOHN");
    });

    it("passes unrecognised names through instead of guessing a volume", () => {
        expect(studyVolumeFromFileName("SOMETHING-ELSE.idml")).toBe("SOMETHING-ELSE");
        expect(studyVolumeFromFileName("JOS-ESTHER-EXTRA.idml")).toBe("JOS-ESTHER-EXTRA");
    });
});

describe("per-language strategies", () => {
    it("forces Structure on French/Marathi/Russian JOB-SNG only", () => {
        for (const language of ["french", "marathi", "russian"]) {
            expect(
                resolveSwapModeForLanguage(
                    getBibleSwapLanguageStrategy(language),
                    "JOB-SNG",
                    "surgical"
                )
            ).toBe("structure");
        }
        for (const language of ["french", "marathi", "hindi"]) {
            expect(
                resolveSwapModeForLanguage(
                    getBibleSwapLanguageStrategy(language),
                    "ACT-REV",
                    "surgical"
                )
            ).toBe("surgical");
        }
        expect(
            resolveSwapModeForLanguage(
                getBibleSwapLanguageStrategy("portuguese"),
                "JOS-EST",
                "surgical"
            )
        ).toBe("surgical");
    });

    it("patches the Portuguese Isaiah plan for the Habakkuk 3 superscription gap", () => {
        const refined = applyLanguagePlanRefinements(
            "portuguese",
            "ISA-MAL",
            emptyRuntimePlan()
        );
        expect(refined.verseMap.get(verseKey("HAB", "3", "1"))).toEqual({
            action: "replace",
            bible: { book: "HAB", chapter: "3", verse: "1" },
        });
        expect(refined.chapterInserts.get(chapterBlockKey("HAB", "3"))).toContainEqual({
            book: "HAB",
            chapter: "3",
            verse: "19",
        });
    });

    it("leaves a Portuguese plan for another volume unchanged", () => {
        const plan = emptyRuntimePlan();
        expect(applyLanguagePlanRefinements("portuguese", "GEN-DEU", plan)).toBe(plan);
    });
});

describe("deserializeVersificationPlan", () => {
    const plan = deserializeVersificationPlan(samplePlan());

    it("rebuilds replace and remove entries", () => {
        expect(plan.verseMap.size).toBe(2);
        expect(plan.verseMap.get(verseKey("JOS", "1", "1"))).toEqual({
            action: "replace",
            bible: { book: "JOS", chapter: "1", verse: "1" },
        });
        expect(plan.verseMap.get(verseKey("JOS", "1", "2"))).toEqual({ action: "remove" });
    });

    it("rebuilds chapter inserts", () => {
        expect(plan.chapterInserts.get(chapterBlockKey("RUT", "4"))).toContainEqual({
            book: "RUT",
            chapter: "4",
            verse: "22",
        });
    });

    it("rebuilds structure chapters keyed by book and chapter", () => {
        expect(plan.structureChapters.get(chapterBlockKey("JOS", "1"))).toMatchObject({
            studyBook: "JOS",
            studyChapter: "1",
            insertOnly: false,
        });
    });
});
