/**
 * Divine-name (YHWH) character-style recognition for Bible Swap — AQU-1959.
 *
 * BGP's requirement: "Lᴏʀᴅ" must keep its **small-caps** character formatting
 * through the swap. The supported marking mechanism is the one the source
 * already carries — the USFM `\nd …\nd*` "name of deity" marker, which the
 * Biblica IDML exports as a character style whose base name is `nd`. Nothing
 * new is asked of translators: they type inside the marked run and the run's
 * style carries the small caps.
 *
 * Two different questions need answering, from two different files:
 *
 *  1. **Story XML** — "is this `<CharacterStyleRange>` the divine name?" The
 *     story only names the style, never defines it, so this is decided by
 *     name. The Biblica packages disagree on the prefix the same role gets
 *     (`head:`/`title:` for paragraphs — see `paragraphStyleRoles.ts`), so the
 *     name test is prefix-agnostic: `nd`, `char:nd`, `cv:nd`, `text:nd`,
 *     `cv%3and`, and the `_sp`/`_sd` layout suffixes all count, while
 *     unrelated styles that merely start with those letters (`ndx`, `nds`) do
 *     not.
 *
 *  2. **Resources/Styles.xml** — "does this character style render small
 *     caps?" There the style is defined, so this is decided by the
 *     definition: InDesign writes `Capitalization="SmallCaps"` (or
 *     `AllSmallcaps` / `CapToSmallCap`). Used when copying the Bible's styles
 *     into a Study package that lacks them.
 */

/**
 * A character-style name whose base is the USFM divine-name marker `nd`.
 *
 * Matches at the start of the name or after `/` or a `:`/`%3a` prefix
 * separator, so bare (`nd`), qualified (`CharacterStyle/cv:nd`) and
 * URL-encoded (`cv%3and`) names all resolve. A trailing `_`-suffix (layout
 * variants such as `nd_sp`) still counts; any other trailing letter or digit
 * does not, so `ndx` and `nd2` are left alone.
 */
const DIVINE_NAME_STYLE = /(?:^|\/|:|%3a)\+?nd(?:_[a-z0-9]+)?$/i;

/** True for a `<CharacterStyleRange>` style that marks the divine name. */
export function isDivineNameCharacterStyle(style: string): boolean {
    if (!style) return false;
    return DIVINE_NAME_STYLE.test(stripStylePrefix(style));
}

function stripStylePrefix(style: string): string {
    return style.replace(/^CharacterStyle\//, "");
}

/** Small-caps capitalization values InDesign writes into a style definition. */
const SMALL_CAPS_CAPITALIZATION = /\bCapitalization="(?:SmallCaps|AllSmallcaps|CapToSmallCap)"/i;

/**
 * True when an IDML `<CharacterStyle>` definition block renders small caps.
 * Inheritance is NOT resolved: a style that only gets its small caps from
 * `BasedOn` is reported by its parent, and both are copied together.
 */
export function characterStyleBlockIsSmallCaps(block: string): boolean {
    return SMALL_CAPS_CAPITALIZATION.test(block || "");
}
