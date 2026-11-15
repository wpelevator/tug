# Watch your servers in a terminal

`tug tui` is a live full-screen view of your whole setup: what needs attention first, then projects, nodes, events, logs and a shell.

```sh
tug tui                 # the overview: attention first, then projects, nodes and events
tug tui nodes           # open on a view: overview, projects, nodes, services, deployments, events, backups, restores, domains, volumes, secrets or credentials
tug tui --readonly      # hide every key that changes something, including the shell
tug tui --once          # print the attention summary and exit 1 when anything of rank 1 to 3 needs attention
tug tui --json          # the same summary as JSON (implies --once)
```

The full screen needs a terminal on stdin and stdout; without one, `tug tui` says so and points at `--once`. It uses the resolved credential, control URL and project like every other command, and needs no more than the `read` role to look: keys that need a higher role are refused with the missing role named. `--once` is the form for cron, a shell prompt or a monitor, and answers with the same ranked list as the screen (see [Attention rules](design/tui.md#1-is-everything-fine-the-glance)); rank 4 items are shown but do not fail the exit code.

### Keys

K9s habits are kept where they carry over. Anything that mutates asks first.

| Key | Action | Needs |
| --- | --- | --- |
| `:` | Command line: jump to a view by name or unique prefix; `tab` completes | any |
| `/` | Filter the current table: a word, `!word` to exclude, `column=word` for one column | any |
| `enter`, `esc` | Open the row, go up a level (`esc` first clears a filter) | any |
| `tab`, `shift-tab` | Next or previous overview pane | any |
| `up`/`down`, `j`/`k`, `pgup`/`pgdn`, `g`/`G` | Move the selection | any |
| `e` | Events for the selected row's project | read |
| `d` | Describe: the row as JSON | read |
| `l` | Follow logs | deploy |
| `i` | Inspect the container (environment values redacted) | deploy |
| `p` | List the project's containers on a node | deploy |
| `s` | Shell in the container | deploy, not in `--readonly` |
| `r` | Restart the service on every node that runs it | deploy, confirm |
| `R` | Roll the project back (never forced, so it refuses while a deployment is active) | deploy, confirm |
| `x` | Cancel a deployment that has not finished | deploy, confirm |
| `b` | Run a backup now: the selected target, or every target of the project | deploy, confirm |
| `ctrl-r` | Poll now | any |
| `?` | Key help | any |
| `q`, `ctrl-c` | Close a screen, then quit; `ctrl-c` quits from anywhere | any |

Confirmations are a `y/N` prompt naming the project and action, and only `y` confirms. A key the role cannot use says which role it needs; an action whose selection does not fit says what to select ("select a service to restart").

## Security

- The screen is an operator client holding an operator credential, like the CLI. It adds no listener, no cache of secrets, no state on disk and no write path other than the existing routes, each checked by control against the credential's own role and project scope. Scoped credentials see only their projects, because `status`, `events`, `backups` and `restores` are already filtered.
- Log lines, event messages, versions, error text and every name in a table come from workloads and users, so they are untrusted. `sanitize` strips escape sequences (CSI, OSC and two-character escapes) and replaces the remaining control characters before anything is stored or drawn, so a container cannot retitle the window, move the cursor or write to the clipboard through the screen. The shell is the one place raw bytes pass through, and it is the PTY of the user's own command.
- `inspect` shows environment names only, as the CLI does. Secret values are never fetched, and the secrets view lists names and versions.
- `R` never sends `force`, so a rollback during an active deployment is refused by control as it is for the CLI.
- A screen left open on a shared machine keeps a connection and the credential in memory. A lock key that blanks the screen is proposed for phase 4.

## Next steps

The design record, with user flows, screen design and what is still proposed, is in [Terminal UI design](design/tui.md).
