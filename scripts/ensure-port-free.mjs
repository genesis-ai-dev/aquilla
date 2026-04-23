#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin, stdout, stderr, argv, exit } from "node:process";

const port = argv[2];
if (!port || !/^\d+$/.test(port)) {
  stderr.write("Usage: ensure-port-free.mjs <port>\n");
  exit(1);
}

function getPids(p) {
  const res = spawnSync("lsof", ["-ti", `:${p}`], { encoding: "utf8" });
  if (!res.stdout) return [];
  return res.stdout.split("\n").filter(Boolean);
}

function describe(pid) {
  const res = spawnSync("ps", ["-p", pid, "-o", "pid=,ppid=,command="], { encoding: "utf8" });
  return (res.stdout || "").trim();
}

let pids = getPids(port);
if (pids.length === 0) exit(0);

stderr.write(`Port ${port} is in use:\n`);
for (const pid of pids) stderr.write(`  ${describe(pid)}\n`);

if (!stdin.isTTY) {
  stderr.write(`\nNot a TTY; skipping kill prompt (let the caller handle the conflict).\n`);
  exit(0);
}

const rl = readline.createInterface({ input: stdin, output: stdout });
const answer = (await rl.question(`Kill ${pids.length} process(es) holding port ${port}? [y/N] `)).trim().toLowerCase();
rl.close();

if (answer !== "y" && answer !== "yes") {
  stderr.write("Aborted.\n");
  exit(1);
}

for (const pid of pids) {
  try { process.kill(Number(pid), "SIGTERM"); } catch {}
}
await new Promise((r) => setTimeout(r, 500));
for (const pid of getPids(port)) {
  try { process.kill(Number(pid), "SIGKILL"); } catch {}
}

pids = getPids(port);
if (pids.length > 0) {
  stderr.write(`Port ${port} still in use by: ${pids.join(", ")}\n`);
  exit(1);
}
stdout.write(`Freed port ${port}.\n`);
