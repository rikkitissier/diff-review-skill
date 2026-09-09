# diff-review

Review a local diff on a GitHub-style page, leave line and file comments, and
hand them back to your agent as a ready-to-paste prompt.

Built to remove the bouncing between GitHub and the terminal: the agent makes
changes, you review them locally, and **Copy Prompt** turns your comments into
the next instruction — file paths, line numbers and the surrounding hunk
included, so the agent knows exactly what you meant.

## Install

```
/plugin marketplace add <owner>/diff-review
/plugin install diff-review@rikki-tools
```

Then `/diff-review`, or ask for a review of the current changes.

## What you get

- File tree with directory rollups, status icons and per-file comment counts
- Unified diff per file with syntax highlighting for ~20 languages
- Line comments (`+` on any row) and file comments
- **Copy Prompt** — comments formatted with quoted context for the agent
- Comments persist per repo + branch and re-anchor by line content, so they
  follow their line when the branch moves
- Light by default, with a dark toggle

Works before you push: the default scope covers committed, uncommitted and
untracked changes. `--pr <n>` reviews an open GitHub PR instead.

## Requirements

Node 20+ and git. No npm dependencies, no build step, no server — each review
is one self-contained HTML file.

## Caveat

`open` cannot reach LaunchServices from inside a sandboxed shell, so the agent
must run the generator with its Bash sandbox disabled for the browser to
launch. Otherwise the page is still written and the `file://` URL printed.
