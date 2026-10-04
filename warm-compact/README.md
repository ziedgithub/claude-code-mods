# warm-compact

Compacts an idle session just before its prompt cache goes cold.

It is separate from Claude Code's own auto-compact, which compacts when the context window fills up. warm-compact acts on time instead: it compacts when you've been away long enough for the cache to lapse, even when the window is far from full.

Claude Code caches the conversation for 5 minutes or an hour after each request, depending on your account. If you come back after that, your next prompt re-reads the whole conversation uncached, which is the most expensive way to read it. warm-compact compacts the session a minute before the cache lapses, while the compaction itself can still read the conversation from the cache. Your next prompt then starts from a short summary.

## When it compacts

- **Only when the session is idle.** Nothing is running, and the prompt box is empty. Typing anything holds it off.
- **Only a large conversation.** Below 50,000 tokens, reading the conversation uncached costs little, so it's left alone.
- **Once per pause.** After a compaction, nothing happens again until your next prompt.
- **Same model.** The cache belongs to one model, so after a `/model` switch there's nothing left to keep warm.

For the 30 seconds before it compacts, the status line under the prompt counts down: `⇊ compacting in 23s, before the cache goes cold · type to hold`. Afterwards, a toast tells you it compacted.

Whether your account caches for 5 minutes or an hour is learned from the requests themselves and remembered between sessions. Until a request shows otherwise, it assumes an hour, as a Claude subscription has.

Headless runs (`claude -p`) are left alone.

## Turning it off for a session

A chip at the right end of the footer row, next to [context-bar](../context-bar/) if you have it, shows `Warm compact on`. Click it to turn it off for this session, and again to turn it back on. Turning it off during the countdown cancels it.

The same from the prompt:

```
/warm-compact        flips it
/warm-compact off    turns it off
/warm-compact on     turns it on
```

A new session, or a `/clear`, starts with it on.

## Options

In `/config`, or in `~/.claude/settings.json` under `pluginConfigs`:

| Option | Default | What it does |
| --- | --- | --- |
| `minTokens` | 50000 | The smallest conversation it compacts, in tokens |
| `leadSeconds` | 60 | How long before the cache lapses the compaction starts (15 at least) |

## Install

```sh
claude plugin marketplace add ziedgithub/claude-code-mods && claude plugin install warm-compact@zied-mods
```

Then restart Claude Code.

See the [repository README](../README.md) for running it from a clone.
