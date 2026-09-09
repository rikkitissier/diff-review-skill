---
name: diff-review
description: Open a GitHub-style review page for the current changes so the user can leave line and file comments and copy them back as a prompt. Use when the user wants to review a diff, review what you just changed, or asks for a review page — and offer it after finishing a batch of changes they will want to look over.
---

<!-- STUB. Rikki writes skill prose himself — this is the minimum needed to make
     the tool work today. Rewrite freely; the two scripts are the real artifact. -->

Generates a single self-contained HTML page that looks like GitHub's review
screen — file list on the left, unified diff per file — with a comment
affordance on every line. Comments never leave the machine: **Copy Prompt**
formats them into a prompt the user pastes back into the agent.

## Running it

```sh
# The skill's own directory differs between a plugin install and a personal
# ~/.claude/skills copy, so resolve it rather than hardcoding either.
DR="$(ls -d "$HOME"/.claude/plugins/marketplaces/*/plugins/diff-review/skills/diff-review 2>/dev/null | head -1)"
[ -n "$DR" ] || DR="$HOME/.claude/skills/diff-review"

node "$DR/generate.mjs" --repo <repo path>
```

`generate.mjs` finds `template.html` next to itself, so only the invocation
path needs resolving.

**Run this with the Bash sandbox disabled.** A sandboxed shell can't reach
LaunchServices, so `open` fails with `procNotFound` and no browser appears —
the generator reports it and exits 3, but the review still doesn't open. If the
sandbox can't be lifted, generate with `--no-open` and open the printed
`file://` URL in a tab via the Chrome DevTools MCP instead. Never leave the
user with only a path printed to the terminal; the point is that the page opens.

It prints the output path on stdout and the clickable `file://` URL on stderr. Default scope is the
merge base with the base branch through to the working tree, which is what the
user is about to review — including uncommitted and untracked files, so it
works before anything is pushed.

| Flag | Effect |
|---|---|
| `--repo <path>` | Repo to diff. Default: cwd. **Always pass this explicitly** in a multi-repo workspace — Bash's cwd persists between calls and may not be the repo you changed. |
| `--base <ref>` | Base ref. Default: `origin/HEAD`, else main, else master. Pass it for repos whose default branch isn't main (`hs-app` uses `develop`, `core-api` uses `master`). |
| `--pr <number>` | Review an open GitHub PR via `gh` instead of local state. |
| `--committed` | Committed changes only — skip working tree and untracked files. |
| `--out <file>` | Output path. Default: a temp file named after repo and branch. |
| `--no-open` | Write the file without opening a browser. |
| `--json` | Print the payload instead of writing HTML. Useful for debugging the parser. |

## What to do with the result

Report the path and that it opened. Don't summarise the diff — the point is
that the user reads it themselves.

When their pasted feedback comes back, each comment carries the file, the line,
and a quoted hunk with `>` marking the commented line. Work through them.
Disagree where you disagree rather than complying silently.

## Regenerating

Re-run the same command after making changes. Comments are keyed on repo +
branch and re-anchor by line **content**, so a comment follows its line when
the line number shifts (marked `moved from N`). A comment whose line has left
the diff entirely is kept and marked, not dropped.

## Stored state

Comments live in `localStorage`, one entry per repo + branch, swept on load:
entries with no comments expire after 7 days, entries holding comments after
30. Opening a review refreshes its timestamp so an in-use review never ages
out, and an entry is never created just by looking at a review. The theme is a
separate global key and is never swept.

## Iterating on the viewer

`template.html` is the whole app — vanilla JS, no dependencies, no build. Edit
it directly; the generator only injects the diff payload at the
`/*__REVIEW_DATA__*/ null` marker. Opening `template.html` on its own shows an
empty state, so it stays testable.

Things worth knowing before editing it:

- Payload injection escapes `<`, `>`, U+2028 and U+2029. Without that, diffing
  a file that contains `</script>` breaks the page.
- The file headers are `position: sticky`. Do not put `overflow: hidden` back
  on `.file` — an `overflow` ancestor becomes the sticky scrollport, which
  shoves every header down over its own first diff rows.
- Theme defaults to light and is stamped by a script in `<head>` before first
  paint. Don't reintroduce a `prefers-color-scheme` block: it would fight the
  light default, and `color-scheme` is set per theme so native checkboxes and
  inputs follow the chosen mode rather than the OS.
- Syntax highlighting runs per line in `hl()`, threading tokeniser state
  separately for the added and removed sides. A line-at-a-time library can't
  see multi-line block comments or template literals; this can.
