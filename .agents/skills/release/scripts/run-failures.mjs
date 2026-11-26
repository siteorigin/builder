#!/usr/bin/env node
// Everything a release run's failures say, in one pass, so triage starts from
// evidence instead of log scrolling. Works while the run is still going: job
// logs come from the jobs API.
//
// For each failed, timed-out or cancelled job of the run's latest attempt it
// prints why it ended (a failing step, the job's own timeout, a runner GitHub
// never assigned, or a plain cancel), and then:
// - unit jobs: the vitest failure blocks and summary, and the slowest test
//   files (what to look at when the job ran out of time);
// - anything else (a build, signing, notarization or publish step): the last
//   40 log lines before the error.
//
// Usage: node run-failures.mjs --run <id> --out <dir> [--job <id>] [--repo owner/name]
// --job analyses that one job whatever its outcome (a green unit job's
// slowest files, for headroom). Writes <dir>/run-<id>/ and prints markdown.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    const value = argv[i + 1];
    if (!argv[i]?.startsWith("--") || !(key in spec) || value === undefined || value.startsWith("--")) {
      console.error(`bad argument near ${argv[i] ?? "(end)"}; accepted: ${Object.keys(spec).map((k) => `--${k}`).join(" ")}`);
      process.exit(2);
    }
    out[key] = value;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2), { run: 1, out: 1, job: 1, repo: 1 });
if (!args.run || !args.out) {
  console.error("usage: run-failures.mjs --run <id> --out <dir> [--job <id>] [--repo owner/name]");
  process.exit(2);
}
const repo = args.repo ?? "siteorigin/builder";
const dir = path.join(args.out, `run-${args.run}`);
mkdirSync(dir, { recursive: true });

const sh = (cmd, a) => execFileSync(cmd, a, { encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });
const ghJson = (...a) => JSON.parse(sh("gh", a));
// Explicit paging: `gh api --paginate` prints one JSON document per page, and
// the jobs API returns 502 on big runs now and then while paging still works.
function paged(endpoint, key) {
  const all = [];
  for (let page = 1; ; page++) {
    const r = ghJson("api", `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const items = key ? r[key] : r;
    all.push(...items);
    if (items.length < 100) return all;
  }
}
// Every terminal control sequence, not just colours, so nothing in a job log
// can drive the terminal this report is printed to. Tabs and newlines stay.
const strip = (s) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
// Log lines are "<timestamp> <text>"; the timestamp is noise here.
const text = (line) => strip(line).replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "");

function jobLog(job) {
  const file = path.join(dir, `job-${job.id}.log`);
  if (!existsSync(file)) {
    // Recent gh refuses to print a log holding terminal escape codes (every
    // vitest log does) unless told it may; an older gh doesn't know the flag.
    let saved = false;
    for (const flags of [["--allow-escape-sequences"], []]) {
      try {
        writeFileSync(file, sh("gh", ["api", ...flags, `repos/${repo}/actions/jobs/${job.id}/logs`]));
        saved = true;
        break;
      } catch {
        // try the next form
      }
    }
    if (!saved) return null;
  }
  return readFileSync(file, "utf8").split("\n").map(text);
}
// A job's ID is its check run's ID. null means the annotations couldn't be read.
function annotations(job) {
  try {
    return paged(`repos/${repo}/check-runs/${job.id}/annotations`).filter((a) => a.annotation_level === "failure").map((a) => a.message);
  } catch {
    return null;
  }
}

const run = ghJson("run", "view", args.run, "--repo", repo, "--json", "status,conclusion,headSha,url,workflowName,attempt");
const allJobs = paged(`repos/${repo}/actions/runs/${args.run}/jobs?filter=latest`, "jobs");
const picked = args.job
  ? allJobs.filter((j) => String(j.id) === args.job)
  : allJobs.filter((j) => ["failure", "cancelled", "timed_out", "startup_failure"].includes(j.conclusion));
const out = [`# ${run.workflowName} ${args.run} (attempt ${run.attempt}, ${run.status}${run.conclusion ? ` ${run.conclusion}` : ""}) at ${run.headSha.slice(0, 10)}`, run.url, ""];
if (!picked.length) {
  out.push(args.job ? `No job ${args.job} in this run.` : "No failed, timed-out or cancelled jobs.");
  // A workflow that can't start (a YAML or permissions error) fails with no jobs at all.
  if (!args.job && !allJobs.length && run.conclusion === "startup_failure") {
    out.push("The run failed to start, with no jobs: the workflow itself is broken (check it with actionlint, and its permissions).");
  } else if (!args.job && !allJobs.length && run.conclusion && run.conclusion !== "success") {
    out.push(`The run ended ${run.conclusion} before any job started.`);
  }
}

function unitReport(log) {
  const lines = [];
  const fails = [];
  for (let i = 0; i < log.length; i++) {
    if (/^\s*FAIL /.test(log[i])) fails.push(log.slice(i, i + 20).join("\n"));
  }
  if (fails.length) lines.push("```", ...[...new Set(fails)].slice(0, 6), "```");
  const summary = log.filter((l) => /^\s*(Test Files|Tests|Duration) /.test(l));
  const done = [];
  for (const l of log) {
    const m = l.match(/[✓❯×] (\S+\.(?:test|spec)\.\S+) \((\d+) tests?[^)]*\)\s+([\d.]+)(m?s)/);
    if (m) done.push({ file: m[1], s: m[4] === "ms" ? Number(m[3]) / 1000 : Number(m[3]) });
  }
  done.sort((a, b) => b.s - a.s);
  if (summary.length) lines.push("```", ...summary, "```");
  else lines.push(`No vitest summary: the job ended mid-suite with ${done.length} test files finished.`);
  lines.push("Slowest test files:", ...done.slice(0, 5).map((d) => `- ${d.s.toFixed(1)} s ${d.file}`));
  return lines;
}

const cancelled = [];
for (const job of picked) {
  const notes = annotations(job);
  const timedOut = notes?.some((n) => /exceeded the maximum execution time/.test(n)) ?? false;
  const unassigned = notes?.find((n) => /not acquired by Runner/.test(n));
  if (job.conclusion === "cancelled" && !timedOut && !unassigned && notes !== null && !args.job) {
    cancelled.push(job.name);
    continue;
  }
  const step = job.steps?.find((s) => s.conclusion === "failure")?.name;
  const why = timedOut
    ? "hit its job timeout"
    : unassigned
      ? `never got a runner ("${unassigned}"): infrastructure, rerun it`
      : step
        ? `failed at step "${step}"`
        : notes === null && job.conclusion === "cancelled"
          ? "cancelled (annotations unreadable, so a timeout isn't ruled out)"
          : job.conclusion;
  out.push(`## ${job.name}: ${why}`, job.html_url);
  if (unassigned) {
    out.push("");
    continue;
  }
  const log = jobLog(job);
  let explained = false;
  // A unit job that failed before vitest ran (npm ci, say) has no vitest
  // output: the log before the error says what happened instead.
  if (/unit/i.test(job.name) && log && log.some((l) => /^\s*(Test Files|FAIL) |^\s*RUN\s+v\d|[✓❯×] \S+\.(?:test|spec)\./.test(l))) {
    out.push(...unitReport(log));
    explained = true;
  }
  if (log && !explained) {
    const errorAt = log.findIndex((l) => /##\[error\]/.test(l));
    const end = errorAt === -1 ? log.length : errorAt + 1;
    out.push("Log before the error:", "```", ...log.slice(Math.max(0, end - 40), end), "```");
  }
  out.push("");
}
if (cancelled.length) {
  out.push(`## Cancelled, not failed (${cancelled.length}): a person, a superseding run or a failed dependency`, ...cancelled.map((n) => `- ${n}`), "");
}

const summary = out.join("\n");
writeFileSync(path.join(dir, "failures.md"), summary);
console.log(summary);
