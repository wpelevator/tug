# Agent instructions

- Until 1.0.0 is tagged this is a greenfield project: refactor in place and prefer a clean design over earlier implementation choices. From 1.0.0 the contracts in docs/releases.md#what-10-freezes bind: a schema change appends a migration step in src/db.ts with a previous-release fixture (never edit a released step), and a breaking change to the CLI, `x-tug`, the wire protocol or a persisted format needs a major.
- Use plan-{task-name}.md to outline the task and a checklist to ensure that all are completed. A plan file is shared working memory across agent sessions; when its work is fully implemented, fold the lasting decisions into README.md/docs and delete the plan file.
- Keep documentation canonical and organized by concern: update the relevant document in place when a decision changes, rather than creating a parallel review or summary file for the same thing.
- After completing tasks, ensure README.md and documentation is up to date and matches the codebase.
- Add tests for all new and updated features, and ensure that existing tests pass. Write assertion messages that state the expected behavior, since they are what a failure shows.
- Use Node.js for all scripting and tooling needs since that is available on the host machine.
- Never hard-wrap Markdown. Keep each paragraph, list item and table row on a single line and let the editor soft-wrap it, so editing a sentence doesn't reflow the whole paragraph into an unreadable diff.
- Every user-facing change needs a changeset (`npm run changeset`); see docs/releases.md. Choose the bump by the compatibility rule in docs/releases.md#choosing-the-bump, not by size: a breaking wire change is `major` (`minor` before 1.0), an additive feature is `minor`, anything that leaves the control/CLI/agent protocol alone is `patch`.
