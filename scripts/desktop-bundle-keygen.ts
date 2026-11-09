// Prints a fresh ed25519 keypair for the desktop hot-bundle channel.
// Run once (`pnpm desktop:bundle:keygen`); never commit the output.
// Spec: docs/superpowers/specs/2026-11-05-desktop-hot-bundle.md.

import { generateBundleKeypair, SIGNING_KEY_ENV } from "./lib/desktop-bundle"

const { privateKeyPem, publicKeyHex } = generateBundleKeypair()

console.log(`# 1. Repo secret ${SIGNING_KEY_ENV} (Settings → Secrets → Actions), the whole PEM:\n`)
console.log(privateKeyPem.trimEnd())
console.log(`\n# 2. Repo secret AQUILLA_BUNDLE_PUBKEY (raw 32-byte public key, hex).`)
console.log(`#    tauri-release.yml passes it to cargo; src-tauri reads it at compile time (option_env!):\n`)
console.log(publicKeyHex)
console.log(`\n# Rotating: set both secrets together. Shells built with the old pubkey ignore`)
console.log(`# bundles signed with the new key until they take a shell update.`)
