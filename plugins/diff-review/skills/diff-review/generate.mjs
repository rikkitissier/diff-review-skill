#!/usr/bin/env node
/**
 * Generate a standalone GitHub-style diff review page for a local git repo.
 *
 * The page is a single self-contained HTML file: no server, no build step, no
 * network. It carries the diff as an inlined JSON payload, lets you leave
 * line-level and file-level comments, and hands back a ready-to-paste prompt.
 *
 * Usage:
 *   node generate.mjs [--repo <path>] [--base <ref>] [--pr <number>]
 *                     [--committed] [--no-untracked] [--out <file>]
 *                     [--no-open] [--json]
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(HERE, "template.html");
const MAX_LINES_PER_FILE = 3000;
const MAX_UNTRACKED_FILES = 200;
const MAX_UNTRACKED_BYTES = 512 * 1024;

/* ------------------------------------------------------------------- args */

function parseArgs(argv) {
  const o = {
    repo: process.cwd(),
    base: null,
    pr: null,
    workingTree: true,
    untracked: true,
    out: null,
    open: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--repo": o.repo = resolvePath(next()); break;
      case "--base": o.base = next(); break;
      case "--pr": o.pr = next().replace(/^#/, ""); break;
      case "--committed": o.workingTree = false; break;
      case "--no-untracked": o.untracked = false; break;
      case "--out": o.out = resolvePath(next()); break;
      case "--no-open": o.open = false; break;
      case "--json": o.json = true; break;
      case "-h": case "--help": usage(); process.exit(0); break;
      default: die(`Unknown argument: ${a}`);
    }
  }
  return o;
}

function usage() {
  console.log(`Generate a diff review page.

  --repo <path>     Repo to diff (default: cwd)
  --base <ref>      Base ref (default: origin/HEAD, else main, else master)
  --pr <number>     Review an existing GitHub PR instead of local state (needs gh)
  --committed       Committed changes only; ignore working tree and untracked files
  --no-untracked    Include the working tree but not untracked files
  --out <file>      Output path (default: a temp file)
  --no-open         Write the file but don't open a viewer
  --json            Print the payload as JSON instead of writing HTML`);
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/* -------------------------------------------------------------------- git */

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.error) die(`${cmd} failed to start: ${r.error.message}`);
  return { status: r.status, out: r.stdout || "", err: r.stderr || "" };
}

function git(repo, args, { allowFail = false } = {}) {
  const r = run("git", args, { cwd: repo });
  if (r.status !== 0 && !allowFail) {
    die(`git ${args.join(" ")}\n${r.err.trim()}`);
  }
  return r.out;
}

function gitLine(repo, args, opts) {
  return git(repo, args, opts).trim();
}

function detectBase(repo) {
  const head = gitLine(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { allowFail: true });
  if (head) return head.replace("refs/remotes/", "");
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    const ok = run("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repo });
    if (ok.status === 0) return ref;
  }
  die("Could not detect a base branch. Pass --base <ref>.");
}

/* ------------------------------------------------------- unified diff parse */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parsePatch(patch) {
  const files = [];
  let f = null;
  let hunk = null;
  let oldNum = 0;
  let newNum = 0;

  const push = () => {
    if (!f) return;
    if (hunk) f.hunks.push(hunk);
    hunk = null;
    files.push(f);
  };

  for (const raw of patch.replace(/\n+$/, "").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      push();
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
      f = {
        path: m ? m[2] : raw.slice(11),
        oldPath: null,
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        hunks: [],
        _rawOld: m ? m[1] : null,
      };
      continue;
    }
    if (!f) continue;

    if (raw.startsWith("new file mode")) { f.status = "added"; continue; }
    if (raw.startsWith("deleted file mode")) { f.status = "deleted"; continue; }
    if (raw.startsWith("rename from ")) { f.status = "renamed"; f.oldPath = raw.slice(12); continue; }
    if (raw.startsWith("rename to ")) { f.path = raw.slice(10); continue; }
    if (raw.startsWith("copy from ")) { f.oldPath = raw.slice(10); continue; }
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
      f.binary = true;
      continue;
    }
    if (raw.startsWith("--- ")) {
      if (raw === "--- /dev/null") f.status = "added";
      continue;
    }
    if (raw.startsWith("+++ ")) {
      if (raw === "+++ /dev/null") f.status = "deleted";
      else f.path = stripPrefix(raw.slice(4));
      continue;
    }
    if (raw.startsWith("index ") || raw.startsWith("old mode ") ||
        raw.startsWith("new mode ") || raw.startsWith("similarity index ") ||
        raw.startsWith("dissimilarity index ")) {
      continue;
    }

    const hm = HUNK_RE.exec(raw);
    if (hm) {
      if (hunk) f.hunks.push(hunk);
      oldNum = parseInt(hm[1], 10);
      newNum = parseInt(hm[3], 10);
      hunk = {
        header: `@@ -${hm[1]},${hm[2] ?? 1} +${hm[3]},${hm[4] ?? 1} @@${hm[5]}`,
        lines: [],
      };
      continue;
    }
    if (!hunk) continue;

    // "\ No newline at end of file" annotates the previous line; keep it out.
    if (raw.startsWith("\\")) continue;

    const kind = raw[0];
    const content = raw.slice(1);
    if (kind === "+") {
      hunk.lines.push({ type: "add", content, oldNum: null, newNum: newNum++ });
      f.additions++;
    } else if (kind === "-") {
      hunk.lines.push({ type: "del", content, oldNum: oldNum++, newNum: null });
      f.deletions++;
    } else if (kind === " " || raw === "") {
      hunk.lines.push({ type: "ctx", content, oldNum: oldNum++, newNum: newNum++ });
    }
  }
  push();

  for (const file of files) {
    if (file.oldPath === file.path) file.oldPath = null;
    if (file.status === "renamed" && !file.oldPath && file._rawOld) file.oldPath = file._rawOld;
    delete file._rawOld;
  }
  return files;
}

/** Synthesize the patch for a new file: every line is an addition. */
function untrackedPatch(abs, rel) {
  let body;
  try {
    if (statSync(abs).size > MAX_UNTRACKED_BYTES) return null;
    body = readFileSync(abs);
  } catch {
    return null;
  }
  const head = `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}`;
  if (body.includes(0)) return `${head}\nBinary files /dev/null and b/${rel} differ`;

  const text = body.toString("utf8").replace(/\n$/, "");
  if (!text) return null;
  const lines = text.split("\n");
  return `${head}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => "+" + l).join("\n");
}

function stripPrefix(p) {
  return p.replace(/^[abciow]\//, "");
}

/* Very large single-file diffs (lockfiles, generated code) would drown the page. */
function capFiles(files) {
  let truncated = 0;
  for (const f of files) {
    let count = 0;
    const kept = [];
    for (const h of f.hunks) {
      if (count >= MAX_LINES_PER_FILE) { truncated++; break; }
      kept.push(h);
      count += h.lines.length;
    }
    if (kept.length !== f.hunks.length) f.truncated = true;
    f.hunks = kept;
  }
  return truncated;
}

/* ------------------------------------------------------------------ collect */

function collectLocal(opts) {
  const repo = opts.repo;
  const root = gitLine(repo, ["rev-parse", "--show-toplevel"]);
  const base = opts.base || detectBase(root);

  const baseSha = gitLine(root, ["rev-parse", base]);
  const headSha = gitLine(root, ["rev-parse", "HEAD"]);
  const branch = gitLine(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const mergeBase = gitLine(root, ["merge-base", base, "HEAD"], { allowFail: true }) || baseSha;

  const diffArgs = ["diff", "--no-color", "-U3", "-M25%", mergeBase];
  if (!opts.workingTree) diffArgs.push("HEAD");
  const patches = [git(root, diffArgs)];

  let untrackedSkipped = null;
  if (opts.workingTree && opts.untracked) {
    const list = git(root, ["ls-files", "--others", "--exclude-standard"])
      .split("\n").map((l) => l.trim()).filter(Boolean);
    if (list.length > MAX_UNTRACKED_FILES) {
      untrackedSkipped = `Skipped ${list.length} untracked files — over the ${MAX_UNTRACKED_FILES} cap, so this repo's .gitignore is probably leaky. Pass --no-untracked to silence this.`;
    } else {
      for (const rel of list) {
        const p = untrackedPatch(join(root, rel), rel);
        if (p) patches.push(p);
      }
    }
  }
  // Trim each patch: a blank joining line would parse as a context line.
  const patch = patches.map((p) => p.replace(/\n+$/, "")).filter(Boolean).join("\n");

  const files = parsePatch(patch);
  const truncated = capFiles(files);
  files.sort((a, b) => a.path.localeCompare(b.path));

  const commits = git(root, ["log", "--format=%h%x1f%s", `${mergeBase}..HEAD`], { allowFail: true })
    .split("\n").filter(Boolean)
    .map((l) => { const [sha, subject] = l.split("\x1f"); return { sha, subject }; });

  const dirty = gitLine(root, ["status", "--porcelain"], { allowFail: true }).length > 0;
  const scope = !opts.workingTree
    ? `${commits.length} commit${commits.length === 1 ? "" : "s"}`
    : dirty
      ? `${commits.length} commit${commits.length === 1 ? "" : "s"} + working tree`
      : `${commits.length} commit${commits.length === 1 ? "" : "s"}`;

  return {
    meta: {
      repo: basename(root),
      cwd: root,
      branch,
      headLabel: branch === "HEAD" ? headSha.slice(0, 10) : branch,
      base,
      baseSha,
      headSha,
      mergeBase,
      scopeLabel: scope,
      commits,
      generatedAt: new Date().toISOString(),
      reviewId: `${basename(root)}:${branch}`,
      notes: [
        truncated ? `${truncated} file(s) were truncated at ${MAX_LINES_PER_FILE} diff lines.` : null,
        untrackedSkipped,
      ].filter(Boolean),
    },
    files,
  };
}

function collectPr(opts) {
  const repo = opts.repo;
  const root = gitLine(repo, ["rev-parse", "--show-toplevel"], { allowFail: true }) || repo;

  const view = run("gh", ["pr", "view", opts.pr, "--json",
    "number,title,headRefName,baseRefName,headRefOid,url,author"], { cwd: root });
  if (view.status !== 0) die(`gh pr view ${opts.pr} failed:\n${view.err.trim()}`);
  const pr = JSON.parse(view.out);

  const d = run("gh", ["pr", "diff", opts.pr, "--patch"], { cwd: root });
  if (d.status !== 0) die(`gh pr diff ${opts.pr} failed:\n${d.err.trim()}`);

  const files = parsePatch(d.out);
  const truncated = capFiles(files);
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    meta: {
      repo: basename(root),
      cwd: root,
      branch: pr.headRefName,
      headLabel: `#${pr.number} ${pr.headRefName}`,
      base: pr.baseRefName,
      baseSha: "",
      headSha: pr.headRefOid || "",
      mergeBase: "",
      scopeLabel: `PR #${pr.number}: ${pr.title}`,
      prUrl: pr.url,
      commits: [],
      generatedAt: new Date().toISOString(),
      reviewId: `${basename(root)}:pr-${pr.number}`,
      notes: truncated ? [`${truncated} file(s) were truncated at ${MAX_LINES_PER_FILE} diff lines.`] : [],
    },
    files,
  };
}


/* ------------------------------------------------------------------- output */

/** Inline JSON safely inside a <script> element. */
function inlineJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(TEMPLATE)) die(`template not found at ${TEMPLATE}`);

  const review = opts.pr ? collectPr(opts) : collectLocal(opts);

  if (!review.files.length) {
    console.error(`No changes to review (${review.meta.headLabel} vs ${review.meta.base}).`);
    // Without this the cap below would swallow the only explanation.
    for (const note of review.meta.notes || []) console.error(note);
    process.exit(2);
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(review, null, 2));
    return;
  }

  const template = readFileSync(TEMPLATE, "utf8");
  const marker = "/*__REVIEW_DATA__*/ null";
  if (!template.includes(marker)) die("template is missing the __REVIEW_DATA__ marker");
  // Function replacer, not a string: a string replacement treats $&, $`, $',
  // $1 and $$ in the payload as substitution patterns. A diff containing
  // something like '^apps(.*)$': '<rootDir>/src/apps$1' would otherwise
  // splice the rest of the template into the middle of the JSON.
  const payload = inlineJson(review);
  const html = template.replace(marker, () => payload);
  // That failure produced a broken page with a silent exit 0, so check that
  // what landed in the file is byte-for-byte what we meant to inject.
  if (!html.includes(payload)) {
    die("the review payload was altered during injection — refusing to write a broken page");
  }

  const slug = `${review.meta.repo}-${review.meta.headLabel}`
    .replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  const out = opts.out || join(tmpdir(), "diff-review", `${slug}.html`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, "utf8");

  const adds = review.files.reduce((a, f) => a + f.additions, 0);
  const dels = review.files.reduce((a, f) => a + f.deletions, 0);
  console.log(out);
  console.error(`${review.files.length} files, +${adds} −${dels} · ${review.meta.scopeLabel}`);

  // Always print the clickable form, whether or not the launch works.
  console.error(`file://${out}`);

  if (opts.open) {
    // Inside cmux the `open` shim reuses the preview surface for a given file,
    // so repeat runs on one branch land in the same tab. Don't try to manage
    // surfaces here: closing and reopening replaces the tab instead.
    const opener = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start" : "xdg-open";
    const r = run(opener, [out]);
    // Silence here was a bug: a sandboxed shell cannot reach LaunchServices,
    // so `open` fails with procNotFound and nothing ever appeared.
    if (r.status !== 0) {
      console.error(`Could not launch a viewer: ${opener} exited ${r.status}.`);
      if (r.err.trim()) console.error(r.err.trim().split("\n")[0]);
      console.error("Open the URL above, or rerun the open step without the Bash sandbox.");
      process.exitCode = 3;
    }
  }
}

main();
