// SHA-256 of the inline pre-paint theme script duplicated in every
// app's index.html. Adding this to each worker's `script-src` CSP lets
// the browser execute the inline `<script>` while keeping the rest of
// the policy strict (no `'unsafe-inline'`).
//
// If you edit the script in any index.html, regenerate the hash with:
//
//   node -e "const fs=require('fs');const c=require('crypto');\
//     const m=fs.readFileSync('apps/login/index.html','utf8')\
//       .match(/<script>([\\s\\S]*?)<\\/script>/);\
//     console.log('sha256-'+c.createHash('sha256').update(m[1]).digest('base64'))"
//
// …then update this constant. Hash is identical across every app because
// the script body is byte-identical.

export const THEME_BOOTSTRAP_INLINE_SCRIPT_SHA256 =
  "'sha256-qASoVislclNht+FyDihDFZAHUgKCDmNzun5cx3Ju+WY='"
