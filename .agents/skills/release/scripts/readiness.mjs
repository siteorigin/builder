#!/usr/bin/env node
// What could still fail in the tag run, found before the tag:
// - which OSes, if any, need a dry run first: a file only the release pipeline
//   exercises (packaging, signing, the release workflows and scripts) or the
//   dependencies changed since the last tag, with no green dry run on that OS
//   that built this exact content. With no tag yet (the first release), every
//   OS needs one: nothing has proven the pipeline end to end on this tree;
// - unit-test jobs whose last release run used most of their timeout.
//
// PR CI runs only the unit tests a change reaches, and the local stabilize pass
// runs the rest (e2e, build, packaged smoke) on macOS. Neither runs the release
// workflows, so a packaging or signing change first meets them here.
//
// Usage: node readiness.mjs [--head <sha|ref>]
//
// Prints JSON: { recommend: "skip" | "dry-run", oses, reasons, unitHeadroom, facts }.
// Exits 2 on bad arguments or a baseline that can't be established.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
const args = parseArgs(process.argv.slice(2), { head: 1 });

const run = (cmd, a) => execFileSync(cmd, a, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).trim();
const git = (...a) => run("git", a);
const gh = (...a) => JSON.parse(run("gh", a));
const tryGit = (...a) => {
  try {
    return git(...a);
  } catch {
    return null;
  }
};
// A workflow's runs, or none when GitHub doesn't know the workflow (it isn't on
// the default branch yet): that is "never ran", not a failure of this script.
const missingWorkflows = new Set();
const workflowRuns = (os, ...filters) => {
  try {
    return gh("run", "list", `--workflow=release-${os}.yml`, ...filters);
  } catch {
    missingWorkflows.add(os);
    return [];
  }
};
const haveCommit = (sha) => tryGit("cat-file", "-e", `${sha}^{commit}`) !== null || tryGit("fetch", "-q", "origin", sha) !== null;
const blob = (ref, file) => tryGit("rev-parse", `${ref}:${file}`);

const head = git("rev-parse", args.head ?? "origin/develop");
const lastTag = git("tag", "-l", "v*", "--sort=-version:refname").split("\n")[0] || null;
if (lastTag && tryGit("merge-base", lastTag, head) === null) {
  console.error(`${lastTag} shares no history with ${head}; run git fetch origin --tags`);
  process.exit(2);
}
if (lastTag && git("rev-parse", "--is-shallow-repository") === "true") {
  const grafts = new Set(readFileSync(git("rev-parse", "--path-format=absolute", "--git-path", "shallow"), "utf8").split("\n").filter(Boolean));
  if (git("rev-list", `${lastTag}..${head}`).split("\n").some((sha) => grafts.has(sha))) {
    console.error(`shallow clone cuts the ${lastTag}..${head} range; run git fetch --unshallow`);
    process.exit(2);
  }
}

const OSES = ["macos", "linux", "windows"];
// Files only the release pipeline exercises, and the OSes each affects. The
// publish path (the publish actions, the version gate, the R2 checks) runs only
// in a tag run: a dry run can't prove it, so it is reported, not dry-run.
const RELEASE_ONLY = [
  { re: /^build\/entitlements|^build\/strip-mac-cache\.cjs$|^scripts\/release\/verify-macos\.sh$/, oses: ["macos"] },
  { re: /^build\/|^electron-builder\.yml$|^scripts\/build-packs\.ts$|^scripts\/packs\//, oses: OSES },
  { re: /^scripts\/release\/(feed|generate-update-metadata|validate-update-metadata)\.ts$/, oses: OSES },
  { re: /^\.github\/workflows\/release-macos\.yml$/, oses: ["macos"] },
  { re: /^\.github\/workflows\/release-linux\.yml$/, oses: ["linux"] },
  { re: /^\.github\/workflows\/release-windows\.yml$/, oses: ["windows"] },
  { re: /^\.github\/actions\/resolve-update-metadata-prefix\//, oses: OSES },
  { re: /^\.github\/actions\/(publish-release|website-notify)\/|^scripts\/release\/(check-version-monotonic|verify-r2-uploads|verify-r2-metadata)\.ts$/, oses: OSES, publishOnly: true },
];
const ruleFor = (file) => RELEASE_ONLY.find((r) => r.re.test(file));
const DEPENDENCY_FILES = ["package.json", "package-lock.json"];

const reasons = [];
const oses = new Set();
const need = (why, which = OSES) => {
  reasons.push(why);
  which.forEach((os) => oses.add(os));
};

// A dry run counts only when it ran the whole pipeline: the build succeeded
// and, on macOS, the signature and notarization were verified.
const dryRuns = {};
for (const os of OSES) {
  const candidates = workflowRuns(os, "--event", "workflow_dispatch", "--limit", "10", "--json", "databaseId,headSha,conclusion,updatedAt,url").filter(
    (r) => r.conclusion === "success"
  );
  dryRuns[os] =
    candidates.find((r) => {
      if (!haveCommit(r.headSha)) return false;
      const jobs = gh("run", "view", String(r.databaseId), "--json", "jobs").jobs;
      const builds = jobs.filter((j) => /^Build/.test(j.name) && j.conclusion === "success");
      if (!builds.length) return false;
      return os !== "macos" || builds.some((j) => j.steps?.some((st) => /Verify the signature and notarization/.test(st.name) && st.conclusion === "success"));
    }) ?? null;
}
const provenBy = (sha, file) => sha && blob(sha, file) === blob(head, file);
const dryRunProves = (os, file) => {
  const r = dryRuns[os];
  return Boolean(r && provenBy(r.headSha, file) && DEPENDENCY_FILES.every((f) => provenBy(r.headSha, f)));
};

const publishOnly = [];
const unproven = [];
let changedFiles = [];
if (!lastTag) {
  // The first release: prove every OS unless a dry run already built this tree's pipeline and dependencies.
  for (const os of OSES) {
    const r = dryRuns[os];
    const sameTree = r && git("diff", "--name-only", r.headSha, head).split("\n").filter(Boolean).every((f) => !ruleFor(f) && !DEPENDENCY_FILES.includes(f));
    if (!sameTree) need(`${os}: no release yet, and no green dry run has built this tree's release pipeline and dependencies`, [os]);
  }
} else {
  changedFiles = git("-c", "diff.renames=false", "diff", "--name-only", `${lastTag}..${head}`).split("\n").filter(Boolean);
  for (const file of changedFiles.filter((f) => ruleFor(f))) {
    const rule = ruleFor(file);
    if (rule.publishOnly) {
      publishOnly.push(file);
      continue;
    }
    const missing = rule.oses.filter((os) => !dryRunProves(os, file));
    if (missing.length) unproven.push({ file, oses: missing });
  }
  for (const os of OSES) {
    const files = unproven.filter((u) => u.oses.includes(os)).map((u) => u.file);
    if (files.length) need(`${os}: release-pipeline files changed since ${lastTag} that no green dry run has built: ${files.slice(0, 6).join(", ")}`, [os]);
  }
  // Packaging pulls native modules and npm's own tree into the app: new
  // dependencies are a packaging change on every OS.
  if (DEPENDENCY_FILES.some((f) => blob(lastTag, f) !== blob(head, f))) {
    const missing = OSES.filter((os) => !DEPENDENCY_FILES.every((f) => dryRunProves(os, f)));
    if (missing.length) need(`dependencies changed since ${lastTag} with no green dry run on ${missing.join(", ")} that built them`, missing);
  }
}

// Unit-test headroom: the longest unit job in each OS's recent green release
// runs against the timeout its workflow sets now. A suite that grows quietly
// blows the limit only in a tag run.
const unitHeadroom = {};
for (const os of OSES) {
  const workflow = tryGit("show", `${head}:.github/workflows/release-${os}.yml`) ?? "";
  const unitBlock = workflow.match(/\n  unit-tests:\n([\s\S]*?)\n  [\w-]+:\n/)?.[1] ?? "";
  const timeout = Number(unitBlock.match(/timeout-minutes:\s*(\d+)/)?.[1]);
  const runs = workflowRuns(os, "--limit", "20", "--json", "databaseId,conclusion,url").filter((r) => r.conclusion === "success");
  let found = null;
  for (const r of runs.slice(0, 5)) {
    const durations = gh("run", "view", String(r.databaseId), "--json", "jobs")
      .jobs.filter((j) => /^Unit tests/i.test(j.name) && j.conclusion === "success" && j.startedAt && j.completedAt)
      .map((j) => (Date.parse(j.completedAt) - Date.parse(j.startedAt)) / 60_000);
    if (durations.length) {
      found = { minutes: Math.max(...durations), run: r.url };
      break;
    }
  }
  if (!found || !timeout) {
    unitHeadroom[os] = { unknown: !found ? "no recent green release run with a unit job" : "no timeout-minutes on the unit-tests job" };
    continue;
  }
  unitHeadroom[os] = { longestMinutes: Math.round(found.minutes), timeout, run: found.run };
  if (found.minutes > timeout * 0.75) need(`${os}: the unit job took ${Math.round(found.minutes)} of its ${timeout} minutes last time; split it or find what got slower before tagging`, [os]);
}

if (missingWorkflows.size) reasons.push(`no runs found for release-${[...missingWorkflows].join(", release-")}.yml (not on the default branch yet, or never run)`);
const recommend = oses.size ? "dry-run" : "skip";
if (recommend === "skip") reasons.push(`every release-pipeline and dependency change since ${lastTag} has been built by a green dry run, or there were none`);
if (publishOnly.length) reasons.push(`publish-path files changed since ${lastTag} (no dry run exercises them; watch the first publish): ${publishOnly.join(", ")}`);

const short = (r) => (r ? { sha: r.headSha.slice(0, 10), at: r.updatedAt, url: r.url } : null);
console.log(
  JSON.stringify(
    {
      recommend,
      oses: OSES.filter((os) => oses.has(os)),
      reasons,
      unitHeadroom,
      facts: {
        head: head.slice(0, 10),
        lastTag,
        releaseOnlyChanged: changedFiles.filter((f) => ruleFor(f)).slice(0, 30),
        unproven,
        publishOnly,
        dryRuns: Object.fromEntries(OSES.map((os) => [os, short(dryRuns[os])])),
      },
    },
    null,
    2
  )
);
