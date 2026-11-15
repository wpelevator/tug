# Review prompts

Run two independent reviews before opening a PR, each in a fresh subagent. Check each finding against the source before changing a page.

## 1. First-principles review

Act as product owner and designer. Name who reads the docs and their jobs. Judge whether the page set serves them. Check each page's first screen for a command or result. Spot-check eight claims against source. List duplicated content, proposal or audit material on operator pages, and breaches of writing-rules.md. Output: must fix, should fix, nice to have, with file and line.

## 2. Adopter run

Follow the README and getting-started as a newcomer who knows Docker and Node but not Tug. Run what can run without a VPS (`tug lint`, `--help`, `init`). Mark each shown output MATCH, MISMATCH or NOT RUNNABLE. Report broken links, circular links and contradictions.
