#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { argv, env, exit, stderr, stdout } from "node:process";

const HF_MODELS_URL = "https://huggingface.co/api/models?author=facebook&search=mms-tts-&limit=1000";
const MODEL_ID_RE = /^facebook\/mms-tts-[a-z0-9_-]+$/i;
const CODE_RE = /^[a-z]{3}([-_][a-z0-9]+)?$/i;

function parseArgs(args) {
  const parsed = {};
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) {
      parsed[body] = "true";
    } else {
      parsed[body.slice(0, eq)] = body.slice(eq + 1);
    }
  }
  return parsed;
}

function printHelp() {
  stdout.write(`Usage:
  npm run mms:r2:publish -- --codes=eng,spa,ita --dry-run
  TRANSFORMERS_JS_DIR=../transformers.js MMS_R2_BUCKET=codex-mms npm run mms:r2:publish --

Options:
  --bucket=<name>              R2 bucket name. Also MMS_R2_BUCKET.
  --codes=<csv>                MMS codes to publish, e.g. eng,spa,ita.
  --models=<csv>               Full model ids, e.g. facebook/mms-tts-ita.
  --limit=<n>                  Limit the model list for validation batches.
  --transformers-js-dir=<dir>  Local clone of huggingface/transformers.js. Also TRANSFORMERS_JS_DIR.
  --converted-dir=<dir>        Converted models dir. Defaults to <transformers-js-dir>/models.
  --work-dir=<dir>             State dir. Defaults to .cache/mms-r2.
  --prefix=<path>              Optional R2 key prefix before the model id.
  --python=<bin>               Python executable. Defaults to python.
  --wrangler=<bin>             Wrangler executable. Defaults to wrangler.
  --skip-convert               Upload already converted files only.
  --skip-upload                Convert only.
  --force                      Ignore prior state and rerun steps.
  --dry-run                    Print commands without running them.
`);
}

function csv(value) {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function normalizePrefix(value) {
  return value.replace(/^\/+|\/+$/g, "");
}

function shellQuote(value) {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function run(command, args, options = {}) {
  stdout.write(`$ ${[command, ...args].map(shellQuote).join(" ")}\n`);
  if (options.dryRun) return;
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    if (!/\brel="?next"?/.test(part)) continue;
    const match = part.match(/<([^>]+)>/);
    if (match) return match[1];
  }
  return null;
}

async function fetchAllModelIds() {
  const ids = [];
  const seenUrls = new Set();
  let url = HF_MODELS_URL;
  while (url) {
    if (seenUrls.has(url)) break;
    seenUrls.add(url);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Hugging Face model list failed: ${response.status} ${response.statusText}`);
    }
    const models = await response.json();
    for (const model of models) {
      const id = model.id || model.modelId;
      if (typeof id === "string" && MODEL_ID_RE.test(id)) ids.push(id);
    }
    url = parseNextLink(response.headers.get("link"));
  }
  return Array.from(new Set(ids)).sort();
}

function modelIdFromCode(code) {
  const normalized = code.trim().toLowerCase();
  if (!CODE_RE.test(normalized)) {
    throw new Error(`Invalid MMS code "${code}". Expected a code such as eng, spa, or ita.`);
  }
  return `facebook/mms-tts-${normalized}`;
}

async function resolveModelIds(options) {
  let ids = csv(options.models);
  if (ids.length === 0) ids = csv(options.codes).map(modelIdFromCode);
  if (ids.length === 0) ids = await fetchAllModelIds();

  for (const id of ids) {
    if (!MODEL_ID_RE.test(id)) {
      throw new Error(`Invalid MMS model id "${id}". Expected facebook/mms-tts-<code>.`);
    }
  }

  const limit = Number(options.limit || 0);
  const unique = Array.from(new Set(ids)).sort();
  return limit > 0 ? unique.slice(0, limit) : unique;
}

function loadState(workDir) {
  const statePath = join(workDir, "state.json");
  if (!existsSync(statePath)) return { version: 1, models: {} };
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function saveState(workDir, state) {
  mkdirSync(workDir, { recursive: true });
  writeFileSync(join(workDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...listFiles(path));
    if (stat.isFile()) out.push(path);
  }
  return out;
}

function convertedModelDir(convertedDir, modelId) {
  return join(convertedDir, ...modelId.split("/"));
}

function uploadModel({ bucket, convertedDir, dryRun, modelId, prefix, wrangler }) {
  const modelDir = convertedModelDir(convertedDir, modelId);
  if (!existsSync(modelDir)) {
    throw new Error(`Converted model folder not found: ${modelDir}`);
  }
  const files = listFiles(modelDir);
  if (files.length === 0) {
    throw new Error(`Converted model folder has no files: ${modelDir}`);
  }
  for (const file of files) {
    const rel = relative(modelDir, file).split("\\").join("/");
    const key = [prefix, modelId, "resolve/main", rel].filter(Boolean).join("/");
    run(wrangler, ["r2", "object", "put", `${bucket}/${key}`, "--file", file], { dryRun });
  }
}

async function main() {
  const options = parseArgs(argv.slice(2));
  if (options.help || options.h) {
    printHelp();
    return;
  }

  const dryRun = options["dry-run"] === "true";
  const skipConvert = options["skip-convert"] === "true";
  const skipUpload = options["skip-upload"] === "true";
  const force = options.force === "true";
  const bucket = options.bucket || env.MMS_R2_BUCKET || "";
  const transformersJsDir = options["transformers-js-dir"] || env.TRANSFORMERS_JS_DIR || "";
  const convertedDir = options["converted-dir"] || env.MMS_CONVERTED_MODELS_DIR || (transformersJsDir ? join(transformersJsDir, "models") : "");
  const workDir = options["work-dir"] || env.MMS_R2_WORK_DIR || ".cache/mms-r2";
  const prefix = normalizePrefix(options.prefix || env.MMS_R2_PREFIX || "");
  const python = options.python || env.PYTHON || "python";
  const wrangler = options.wrangler || env.WRANGLER || "wrangler";

  if (!skipConvert && !transformersJsDir) {
    throw new Error("Missing --transformers-js-dir or TRANSFORMERS_JS_DIR.");
  }
  if (!skipUpload && !bucket) {
    throw new Error("Missing --bucket or MMS_R2_BUCKET.");
  }
  if (!skipUpload && !convertedDir) {
    throw new Error("Missing --converted-dir or MMS_CONVERTED_MODELS_DIR.");
  }

  const modelIds = await resolveModelIds(options);
  const state = loadState(workDir);
  stdout.write(`Publishing ${modelIds.length} MMS model(s).\n`);

  for (const modelId of modelIds) {
    const record = state.models[modelId] || {};
    state.models[modelId] = record;
    stdout.write(`\n== ${modelId} ==\n`);
    try {
      if (!skipConvert && (force || !record.convertedAt)) {
        run(python, ["-m", "scripts.convert", "--quantize", "--model_id", modelId], {
          cwd: transformersJsDir,
          dryRun,
        });
        if (!dryRun) {
          record.convertedAt = new Date().toISOString();
          saveState(workDir, state);
        }
      } else {
        stdout.write("convert: skipped\n");
      }

      if (!skipUpload && (force || !record.uploadedAt)) {
        uploadModel({ bucket, convertedDir, dryRun, modelId, prefix, wrangler });
        if (!dryRun) {
          record.uploadedAt = new Date().toISOString();
          record.error = undefined;
          saveState(workDir, state);
        }
      } else {
        stdout.write("upload: skipped\n");
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error);
      if (!dryRun) saveState(workDir, state);
      throw error;
    }
  }
}

main().catch((error) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  exit(1);
});
