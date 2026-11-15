---
name: tug-docs
description: Write, rewrite, restructure or review Tug documentation (README.md and docs/*.md) so readers see real command output first and reach a result fast. Use when creating or updating a docs page, the README, a quickstart, a troubleshooting or production page or a command reference, when deciding how to split or move pages, or when a code change adds a command, flag, `x-tug` key or config key that docs must cover.
---

# Tug docs

Docs here are task-first: each guide opens with a command and its real output, then short recipes, then reference. A reader sees what Tug does within ten seconds and has a first result within a minute. Read `docs/getting-started.md` and one guide before writing a new page.

## Principles

- **Value first.** Open with the outcome the reader gets, not with how Tug is built.
- **Progressive disclosure.** See it (a command and its output), do it (the copy-paste path), shape it (recipes), look it up (tables and edge cases). Reference detail never sits above a result.
- **Never invent output.** Run the command and paste what it prints. If you cannot run it (no VPS, no Docker), show the command without output. Normalize paths, addresses, keys, digests and dates.
- **Decide the structure first.** Retitling pages keeps the old shape. List the reader's jobs, then split, merge, move and add pages, as in [references/structure.md](references/structure.md).
- **Keep reader docs and contributor docs apart.** Guides and reference are for operators. Design proposals, audits, evaluations and benchmarks live in `docs/design/` or `docs/contributing/` and are never linked as the way to do something.
- **Don't make users do what a command can do.** Show `tug secret set`, not a file to write by hand.

## Workflow

1. Name the reader's job and check whether a page for it exists. One job per page.
2. Run the real commands: `tug lint` and `--help` run anywhere, the rest needs control and a node. See [references/verification.md](references/verification.md).
3. Write from [references/page-template.md](references/page-template.md).
4. Apply [references/writing-rules.md](references/writing-rules.md) to everything you wrote or touched.
5. Cover the source: every command, flag, `x-tug` key and config key appears where a reader would look for it.
6. Check links and anchors, then review with the prompts in [references/review-prompts.md](references/review-prompts.md).
7. Add a changeset (`npm run changeset`, usually `patch`) because docs ship in the npm package. When a page is renamed or deleted, say in the PR that outside links break.

## Page types

| The reader wants to | Page | Opens with |
|---|---|---|
| Try Tug | Quickstart | A first result in minutes |
| Do one task | Guide | The command and its real output |
| Pick between commands | Hub (`docs/index.md`) | A table from task to page |
| Look something up | Reference | A table grouped by task, defaults stated |
| Run it for real | Production checklist | Things to check, each linking to its guide |
| Fix an error | Troubleshooting | A table from the message to cause and fix |
| Decide whether to adopt | Comparison | A verdict and the conditions behind it |

## Quick checks before you finish

- The first screen of each guide shows a command or a result.
- Every command shown runs as written, and none has invented output.
- Each setting a reader looks up has its default.
- No reader page has requirement IDs, "proposal", "audit finding" or changelog voice ("now", "no longer", "as before"). Version history goes in the changelog, and the upgrade note per major goes in `docs/releases.md`.
- Markdown is not hard-wrapped, and links are relative `.md` links that resolve.
