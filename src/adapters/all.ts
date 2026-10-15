/** Registers every built-in adapter. Import for side effects. */
import { registerAdapter } from "./registry.ts"
import { markdownAdapter } from "./markdown/index.ts"
import { jsonAdapter } from "./json/index.ts"

registerAdapter(markdownAdapter)
registerAdapter(jsonAdapter)
