# Verification

## 1. Run the commands

- `tug lint` and every `--help` run with no server. Capture their output from the current build (`npm run build`, then `node dist/cli.js ...`).
- Commands that need control or a node run against a Lima or QEMU VM, or the Docker stack in [development](../../../../docs/development.md). Run them from a pinned worktree, because other sessions switch branches in the shared checkout.
- With no host available, show the command and say what it does. Do not write output.
- Normalize before pasting: `203.0.113.x` for addresses, `<digest>`, `<key>` and fixed dates.

## 2. Cover the source

```sh
node dist/cli.js --help
node dist/cli.js deploy --help | grep -o -- '--[a-z0-9-]*' | sort -u | while read -r f; do
  grep -rqF -- "$f" docs README.md || echo "not documented: $f"
done
```

Check every command is in the CLI reference grouped by task, every `x-tug` key is in `docs/compose.md` and `x-tug.schema.json`, and every config key and environment variable is in `docs/configuration.md`.

## 3. Check claims at the edges

Spot-check at least eight claims against source: defaults, limits, exit codes, variable names, messages. Check conditional behavior (a flag that needs another flag, a value that needs a role).

## 4. Check links

```sh
node tools/scripts/check-doc-links.mjs
```

The script checks relative links and anchors in README.md and docs/. After renaming or splitting a heading, search for the old anchor.
