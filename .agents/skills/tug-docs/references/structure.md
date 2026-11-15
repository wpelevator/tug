# Structure

Decide the page set before writing a page.

## Decide the page set

1. **List the jobs** in the reader's words: try it, deploy, add HTTPS, back up, roll back, add a server, move servers, upgrade, fix an error, look something up.
2. **Split a page** when it passes about 150 lines of prose, serves two jobs, or mixes a how-to with design rationale. Move the rationale to its own design page and list it in `docs/design-records.md`.
3. **Keep a page whole** when it is a short lookup readers scan (a CLI page, a settings table).
4. **Merge a page** under about 20 lines that only points elsewhere.
5. **Name files after titles** and update every link when a title changes.
6. **Keep a fact in one place** and link to it.

## File names

File names are URL path elements, so they follow one scheme.

- **Lowercase kebab-case**, one to three words, ending in `.md`: `healthchecks.md`, `control-plane.md`.
- **A topic noun, not a verb or gerund.** `upgrades.md`, `backups.md`, `migration.md`, not `upgrading.md`. Command names that are nouns keep the command's name (`cli.md`, `tui.md`).
- **Plural for a collection, singular for a mass topic or concept.** `backups`, `nodes`, but `networking`, `migration`, `placement`.
- **No qualifiers that describe the writing.** Not `*-reference`, `*-guide`, `*-overview`, `*-proposal`. The folder and the status line carry that.
- **No subfolders.** `docs/` is flat, so every page is `/docs/<name>`. `docs/index.md` is the only hub for operators, and `docs/design-records.md` is the hub for contributors and evaluators.
- **A design page that shares a topic with an operator page takes a suffix that says what it is**, as in `tui.md` and `tui-design.md`, `terminology.md` and `terminology-review.md`, and `ingress.md` and `ingress-design.md`.
- **Rename only when the job changes.** A rename breaks outside links, so name the old URLs in the pull request.

## Layout

| Group | Pages | Hub |
|---|---|---|
| Operators | Getting started, guides by task, production checklist, troubleshooting, reference | `index.md` |
| Contributors and evaluators | Development, testing, roadmap, proposals, audits, evaluations and comparisons. State at the top of each design page whether it is a proposal, a record or shipped behavior | `design-records.md` for design pages, and `index.md` links development and testing |

## Reference pages

- Group tables by area, not alphabetically, and link each group to the guide that explains it.
- Put the default in every row, and the release that added a setting when it came after 1.0.
- Put exact messages in tables a reader can search: the message as printed, the cause, the fix.

## Reader-facing prose

- State behavior as plain present-tense facts.
- Put shipped behavior in guides. A section called "Proposed" or "Open questions" does not belong on an operator page.
- A page is a design page if most of it is options considered, findings or a checklist for unbuilt work. Move it.
