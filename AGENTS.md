# Agent instructions

- This is a greenfield project so don't consider migrations and refactor in place.
- Existing project conventions and earlier implementation choices are not constraints: prefer a clean design and change them when a better approach serves the task.
- Use plan-{task-name}.md to outline the task and a checklist to ensure that all are completed. A plan file is shared working memory across agent sessions; when its work is fully implemented, fold the lasting decisions into README.md/docs and delete the plan file.
- Keep documentation canonical and organized by concern: update the relevant document in place when a decision changes, rather than creating a parallel review or summary file for the same thing.
- After completing tasks, ensure README.md and documentation is up to date and matches the codebase.
- Add tests for all new and updated features, and ensure that existing tests pass. Write assertion messages that state the expected behavior, since they are what a failure shows.
- Use Node.js for all scripting and tooling needs since that is available on the host machine.
- Never hard-wrap Markdown. Keep each paragraph, list item and table row on a single line and let the editor soft-wrap it, so editing a sentence doesn't reflow the whole paragraph into an unreadable diff.
