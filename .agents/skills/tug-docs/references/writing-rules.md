# Writing rules

Run an edit pass with these rules over every page you write or change.

1. **Lead with the point.** Open with the outcome or the command. Cut "In this guide".
2. **Concrete beats abstract.** "`tug rollback` activates the previous successful deployment", not "ensures safe recovery". If a sentence fits any tool unchanged, replace it with a mechanism or an example.
3. **Don't tell the reader what to think.** No "importantly" or "the key point". Show the consequence.
4. **Plain verbs, active voice.** "The agent dials control", not "a connection is established".
5. **Say the thing, not what it isn't.** State Y instead of "not X, but Y".
6. **One term per concept.** Follow [terminology](../../../../docs/terminology.md): control, node, agent, project, deployment.
7. **Cut filler.** Banned: leverage, utilize, seamless, robust, streamline, empower, powerful, effortless, delve. Cut `simply`, `just`, `easily`.
8. **Every claim traces to a command or a line of source.** State conditions: "rolls back when a node reports the new version unhealthy and `rollback: auto` is set".
9. **State limits where they apply**, in the main text, with the cost: what Tug cannot undo, what a `deploy` credential can read.
10. **Format follows content.** No emoji, no mid-sentence bold, no em dashes, no heading over a two-line section.
11. **End on the next useful step**, not a recap.
12. **Never hard-wrap Markdown.** One paragraph, list item or table row per line.

## How to check a page

Scan for banned words, em dashes, "not ... but", trailing "-ing" clauses that explain nothing, sentences starting "This" or "It" that say nothing, and claims with no command or source behind them. Keep phrasing that is already clear and accurate.
