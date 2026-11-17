/**
 * AQU-2487 (import sweep, Nov 2; review, Nov 9): a voice belongs to the
 * project, not to a file. Its reference clip, its design previews and the
 * designed voice itself go through routes that take any of the project's sync
 * tokens (`verifyTokenForProject`), and a file id is needed only to mint one.
 * With no file open (the Voices panel on "No file selected") this stands in
 * for that file, as `ELEVENLABS_PROJECT_SCOPE_FILE_ID` does.
 *
 * Only for those project-scoped routes. Synthesizing speech for a line
 * (`/api/v1/voice/tts`) stores audio under a real file and checks the token
 * against it, so it still needs one.
 */
export const VOICE_PROJECT_SCOPE_FILE_ID = "_voices"
