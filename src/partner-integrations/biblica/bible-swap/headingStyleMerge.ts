/**
 * Copy Bible styles the swapped-in text needs into the Study IDML style sheet:
 * heading-role paragraph styles, and the small-caps character styles that
 * carry the divine name (AQU-1959).
 *
 * Structure swap inserts Portuguese `title:s1` (and the rest of the `title:*`
 * heading family) as whole paragraphs. The Study package only defines the
 * equivalent `head:s1` styles, so InDesign treats `title:s1` as missing and
 * falls back to body text (Charis SIL Regular) — dropping both Source Sans 3
 * and the nested Semibold (`#base.bd`) that the Bible uses.
 *
 * The Study already has `#base.title` (Myriad Pro, for `title:mt*` book
 * titles). Copied heading styles therefore keep their Bible BasedOn, but the
 * Bible's resolved AppliedFont is stamped on so they do not inherit the
 * Study's different title font.
 */

import { isHeadingRoleTitleStyle } from "./paragraphStyleRoles";
import {
    characterStyleBlockIsSmallCaps,
    isDivineNameCharacterStyle,
} from "./divineNameStyles";

interface StyleRecord {
    self: string;
    block: string;
    basedOn?: string;
    appliedFont?: string;
}

export function mergeBibleHeadingStylesIntoStudyStylesXml(
    studyStylesXml: string,
    bibleStylesXml: string
): string {
    if (!studyStylesXml || !bibleStylesXml) {
        return studyStylesXml;
    }

    const studyStyles = extractNamedBlocks(studyStylesXml, "ParagraphStyle");
    const bibleStyles = extractNamedBlocks(bibleStylesXml, "ParagraphStyle");
    const toInsert: string[] = [];

    for (const [self, bible] of bibleStyles) {
        if (!isHeadingRoleTitleStyle(self) || studyStyles.has(self)) {
            continue;
        }

        let block = withHeadingBalanceOff(bible.block);
        const basedOn = bible.basedOn;
        if (basedOn && studyStyles.has(basedOn) && !isHeadingRoleTitleStyle(basedOn)) {
            const bibleFont = resolveAppliedFont(self, bibleStyles);
            const studyBaseFont = resolveAppliedFont(basedOn, studyStyles);
            if (bibleFont && bibleFont !== studyBaseFont) {
                block = stampAppliedFont(block, bibleFont);
            }
        }
        toInsert.push(block);
    }

    const inserted =
        toInsert.length === 0
            ? studyStylesXml
            : insertParagraphStyles(studyStylesXml, toInsert);
    return turnOffVeeShapedHeadings(inserted);
}

/** Vee balancing splits a long section heading onto a short second line. */
function withHeadingBalanceOff(block: string): string {
    if (/BalanceRaggedLines="/.test(block)) {
        return block.replace(/BalanceRaggedLines="[^"]*"/, 'BalanceRaggedLines="Off"');
    }
    return block.replace(
        /(<ParagraphStyle\b[^>]*?)(\/?>)/,
        '$1 BalanceRaggedLines="Off"$2'
    );
}

function turnOffVeeShapedHeadings(stylesXml: string): string {
    const styles = extractNamedBlocks(stylesXml, "ParagraphStyle");
    let out = stylesXml;
    for (const [self, style] of styles) {
        if (!isHeadingRoleTitleStyle(self)) continue;
        if (!style.block.includes('BalanceRaggedLines="VeeShape"')) continue;
        out = out.replace(
            style.block,
            style.block.replace('BalanceRaggedLines="VeeShape"', 'BalanceRaggedLines="Off"')
        );
    }
    return out;
}

const PORTUGUESE_BRAZILIAN = "$ID/Portuguese: Brazilian";
const ENGLISH_LANGUAGES = new Set(["$ID/English: UK", "$ID/English: USA"]);

/**
 * Notes and boxes are hyphenated by InDesign. The study sheet still names
 * English, so a Portuguese swap breaks those words with English rules.
 * Bible text already carries its own discretionary hyphens and is left alone.
 */
function ownStyleField(block: string, name: string): string {
    return (
        block.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ??
        block.match(new RegExp(`<${name}\\b[^>]*>([^<]*)</${name}>`))?.[1] ??
        ""
    );
}

function styleByRef(
    styles: Map<string, StyleRecord>,
    ref: string
): [string, StyleRecord] | null {
    if (!ref) return null;
    if (styles.has(ref)) return [ref, styles.get(ref)!];
    const prefixed = ref.startsWith("ParagraphStyle/")
        ? ref
        : `ParagraphStyle/${ref}`;
    if (styles.has(prefixed)) return [prefixed, styles.get(prefixed)!];
    return null;
}

/**
 * Notes inherit `$ID/English: UK` from `#base.text` and hyphenation from a
 * parent that never restates it. Stamp the style that actually owns the
 * English language when it, or anything that inherits it, hyphenates.
 */
export function stampPortugueseHyphenationLanguage(stylesXml: string): string {
    const styles = extractNamedBlocks(stylesXml, "ParagraphStyle");
    const resolved = (start: string, name: string): string => {
        const seen = new Set<string>();
        let ref: string | undefined = start;
        while (ref && !seen.has(ref)) {
            seen.add(ref);
            const found = styleByRef(styles, ref);
            if (!found) return "";
            const value = ownStyleField(found[1].block, name);
            if (value) return value;
            ref = found[1].basedOn;
        }
        return "";
    };
    const languageOwner = (start: string): string | null => {
        const seen = new Set<string>();
        let ref: string | undefined = start;
        while (ref && !seen.has(ref)) {
            seen.add(ref);
            const found = styleByRef(styles, ref);
            if (!found) return null;
            if (ownStyleField(found[1].block, "AppliedLanguage")) return found[0];
            ref = found[1].basedOn;
        }
        return null;
    };

    const owners = new Set<string>();
    for (const [self] of styles) {
        const language = resolved(self, "AppliedLanguage");
        if (!ENGLISH_LANGUAGES.has(language)) continue;
        if (resolved(self, "Hyphenation") !== "true") continue;
        const owner = languageOwner(self);
        if (owner) owners.add(owner);
    }

    let out = stylesXml;
    for (const self of owners) {
        const style = styles.get(self);
        if (!style) continue;
        if (!ENGLISH_LANGUAGES.has(ownStyleField(style.block, "AppliedLanguage"))) {
            continue;
        }
        out = out.replace(
            style.block,
            style.block.replace(
                /AppliedLanguage="[^"]*"/,
                `AppliedLanguage="${PORTUGUESE_BRAZILIAN}"`
            )
        );
    }
    return out;
}

function appliedFontOf(block: string): string | undefined {
    return (
        block.match(/<AppliedFont\b[^>]*>([^<]+)<\/AppliedFont>/)?.[1] ??
        block.match(/\bAppliedFont="([^"]+)"/)?.[1]
    );
}

function setAppliedFont(block: string, font: string): string {
    if (/<AppliedFont\b/.test(block)) {
        return block.replace(
            /(<AppliedFont\b[^>]*>)[^<]*(<\/AppliedFont>)/,
            `$1${font}$2`
        );
    }
    if (/\bAppliedFont="/.test(block)) {
        return block.replace(/\bAppliedFont="[^"]*"/, `AppliedFont="${font}"`);
    }
    return block.replace("<CharacterStyle", `<CharacterStyle AppliedFont="${font}"`);
}

function decodedStyleSelf(self: string): string {
    try {
        return decodeURIComponent(self);
    } catch {
        return self;
    }
}

/**
 * The footnote space inherits Charis SIL and the chapter-opening call inherits
 * Source Sans 3. Point both at the font the rest of that note already uses.
 */
export function retargetFootnoteCharacterFonts(stylesXml: string): string {
    const styles = extractNamedBlocks(stylesXml, "CharacterStyle");
    const byName = new Map<string, StyleRecord>();
    for (const [self, style] of styles) {
        byName.set(decodedStyleSelf(self), style);
    }
    const pairs: Array<[string, string]> = [
        ["CharacterStyle/notes:fr_sp", "CharacterStyle/notes:f"],
        ["CharacterStyle/notes:f_call_dc", "CharacterStyle/notes:f_call"],
    ];
    let out = stylesXml;
    for (const [targetName, sourceName] of pairs) {
        const target = byName.get(targetName);
        const source = byName.get(sourceName);
        const font = source ? appliedFontOf(source.block) : undefined;
        if (!target || !font) continue;
        const patched = setAppliedFont(target.block, font);
        if (patched === target.block) continue;
        out = out.replace(target.block, patched);
    }
    return out;
}


/**
 * Copy the Bible's small-caps character styles into the Study style sheet
 * (AQU-1959).
 *
 * Structure swap — and the surgical swap's span-layout path — splice whole
 * Bible paragraphs into the Study stories, divine-name (`nd`)
 * `<CharacterStyleRange>`s included. The Study package defines only its own
 * character styles, so a Bible style it has never heard of resolves to
 * nothing and InDesign prints the divine name as ordinary body text: the
 * small caps BGP asked for are lost even though the run survived the swap.
 *
 * Only two narrow families are copied — a style the Bible marks as the divine
 * name, and any style whose definition declares small-caps capitalization —
 * so the Study's own styling is never otherwise disturbed. A copied style's
 * `BasedOn` parent is copied with it when the Study lacks that too, since
 * InDesign resolves capitalization through the chain.
 */
export function mergeBibleSmallCapsCharacterStylesIntoStudyStylesXml(
    studyStylesXml: string,
    bibleStylesXml: string
): string {
    if (!studyStylesXml || !bibleStylesXml) {
        return studyStylesXml;
    }

    const studyStyles = extractNamedBlocks(studyStylesXml, "CharacterStyle");
    const bibleStyles = extractNamedBlocks(bibleStylesXml, "CharacterStyle");
    const toInsert = new Map<string, string>();

    // `BasedOn` is written either qualified ("CharacterStyle/nd") or bare
    // ("nd"); `Self` is always qualified, so bare refs need the prefix to
    // resolve against either style table.
    const qualify = (ref: string): string =>
        ref.startsWith("CharacterStyle/") ? ref : `CharacterStyle/${ref}`;

    const addWithParents = (self: string): void => {
        let current: string | undefined = self;
        while (current && !studyStyles.has(current) && !toInsert.has(current)) {
            const style: StyleRecord | undefined = bibleStyles.get(current);
            if (!style) return;
            toInsert.set(current, style.block);
            current = style.basedOn ? qualify(style.basedOn) : undefined;
        }
    };

    for (const [self, bible] of bibleStyles) {
        if (studyStyles.has(self)) continue;
        if (!isDivineNameCharacterStyle(self) && !characterStyleBlockIsSmallCaps(bible.block)) {
            continue;
        }
        addWithParents(self);
    }

    if (toInsert.size === 0) {
        return studyStylesXml;
    }

    return insertCharacterStyles(studyStylesXml, [...toInsert.values()]);
}

function insertCharacterStyles(studyStylesXml: string, blocks: string[]): string {
    const joined = blocks.join("\n");
    const rootClose = studyStylesXml.lastIndexOf("</RootCharacterStyleGroup>");
    if (rootClose >= 0) {
        return (
            studyStylesXml.slice(0, rootClose) + joined + "\n\t" + studyStylesXml.slice(rootClose)
        );
    }
    return `${studyStylesXml}\n${joined}`;
}

function extractNamedBlocks(xml: string, tagName: string): Map<string, StyleRecord> {
    const map = new Map<string, StyleRecord>();
    const openRe = new RegExp(`<${tagName}\\b`, "gi");
    let match: RegExpExecArray | null;

    while ((match = openRe.exec(xml))) {
        const start = match.index;
        const afterOpen = xml.indexOf(">", start);
        if (afterOpen < 0) {
            break;
        }

        const openTag = xml.slice(start, afterOpen + 1);
        const self = openTag.match(/\bSelf="([^"]+)"/)?.[1];
        let end = afterOpen + 1;
        if (!openTag.endsWith("/>")) {
            const close = `</${tagName}>`;
            const closeAt = xml.indexOf(close, afterOpen);
            if (closeAt < 0) {
                break;
            }
            end = closeAt + close.length;
        }

        openRe.lastIndex = end;
        if (!self) {
            continue;
        }

        const block = xml.slice(start, end);
        map.set(self, {
            self,
            block,
            basedOn: block.match(/<BasedOn\b[^>]*>([^<]+)<\/BasedOn>/)?.[1],
            appliedFont: block.match(/<AppliedFont\b[^>]*>([^<]+)<\/AppliedFont>/)?.[1],
        });
    }

    return map;
}

function resolveAppliedFont(
    self: string,
    styles: Map<string, StyleRecord>
): string | undefined {
    const seen = new Set<string>();
    let current: string | undefined = self;

    while (current && !seen.has(current)) {
        seen.add(current);
        const entry = styles.get(current);
        if (!entry) {
            return undefined;
        }
        if (entry.appliedFont) {
            return entry.appliedFont;
        }
        current = entry.basedOn;
    }

    return undefined;
}

function stampAppliedFont(block: string, font: string): string {
    if (/<AppliedFont\b/.test(block)) {
        return block;
    }

    const stamped = `\t<AppliedFont type="string">${font}</AppliedFont>\n`;
    if (/<\/Properties>/.test(block)) {
        return block.replace(
            /<\/Properties>(\s*)<\/ParagraphStyle>/,
            `${stamped}\t\t\t\t</Properties>$1</ParagraphStyle>`
        );
    }

    return block.replace(
        /<\/ParagraphStyle>/,
        `<Properties>\n${stamped}\t\t\t</Properties>\n\t\t</ParagraphStyle>`
    );
}

function insertParagraphStyles(studyStylesXml: string, blocks: string[]): string {
    const joined = blocks.join("\n");
    const titleGroup = /<ParagraphStyleGroup\b[^>]*Self="ParagraphStyleGroup\/\$ID\/title"[^>]*>/i.exec(
        studyStylesXml
    );
    if (titleGroup && titleGroup.index !== undefined) {
        const closeAt = studyStylesXml.indexOf(
            "</ParagraphStyleGroup>",
            titleGroup.index + titleGroup[0].length
        );
        if (closeAt >= 0) {
            return (
                studyStylesXml.slice(0, closeAt) +
                joined +
                "\n\t\t" +
                studyStylesXml.slice(closeAt)
            );
        }
    }

    const rootClose = studyStylesXml.lastIndexOf("</RootParagraphStyleGroup>");
    if (rootClose >= 0) {
        return studyStylesXml.slice(0, rootClose) + joined + "\n\t" + studyStylesXml.slice(rootClose);
    }

    return `${studyStylesXml}\n${joined}`;
}
