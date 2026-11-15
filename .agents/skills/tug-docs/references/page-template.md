# Page template

A guide stays under about 150 lines of prose. Long reference goes under `## Reference` or on its own page.

````md
# <The outcome, not the command name>

<One sentence: what the reader gets.>

```sh
tug <command>
```

```text
<The real output, normalized.>
```

<One or two sentences on what the output shows. Show the failing run too when the reader will meet it.>

## Common tasks

<Three to five recipes, each titled by intent, each a command and a sentence.>

## Reference

<Option tables, defaults, edge cases.>

## Next steps

<One or two links that continue the journey.>
````

## Parts

- **Title.** The outcome ("Back up a volume").
- **Command and output.** Command in an `sh` fence, output in a `text` fence, no leading `$`.
- **Recipes.** Titled by what the reader wants, not by the flag.
- **Quickstart.** Three steps at most, each a command, its output and one sentence.
- **Hub.** A table from task to command to page, and the facts that apply to all of them.
