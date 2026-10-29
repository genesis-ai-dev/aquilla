/**
 * Every catalog, installed synchronously, for the tests that assert text in a
 * non-English locale (AQU-1991).
 *
 * `src/test-setup.ts` used to install every catalog for every test file. The
 * 18 locale modules are 15 MB of TypeScript, and each isolated worker evaluated
 * all of them again, so that one import was 47% of the CI `unit` job's time
 * across ~2,100 files. English ships with the app, so a test that renders
 * English needs nothing. A test that renders another locale imports this module
 * for its side effect before anything renders, and components then find every
 * catalog at once, as they did before AQU-2090 made loading on-demand:
 *
 *   import "@/test-utils/all-catalogs"
 *
 * Without it a non-English locale takes the app's real path: the catalog
 * arrives after a dynamic import, so a synchronous assertion on translated text
 * sees the English fallback. `answerFromCatalogsForTests(null)` undoes this for
 * a test that wants that real path.
 */
import { CATALOGS } from "@/lib/i18n/messages/all"
import { answerFromCatalogsForTests } from "@/lib/i18n/messages"

answerFromCatalogsForTests(CATALOGS)

export { CATALOGS }
