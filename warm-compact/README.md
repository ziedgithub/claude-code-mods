# warm-compact

Compacts an idle session just before its prompt cache goes cold, or keeps the cache warm while you're away.

It is separate from Claude Code's own auto-compact, which compacts when the context window fills up. warm-compact acts on time instead: it compacts when you've been away long enough for the cache to lapse, even when the window is far from full.

Claude Code caches the conversation for 5 minutes or an hour after each request, depending on your account. If you come back after that, your next prompt re-reads the whole conversation uncached, which is the most expensive way to read it. warm-compact compacts the session a minute before the cache lapses, while the compaction itself can still read the conversation from the cache. Your next prompt then starts from a short summary.

## When it compacts

- **Only when the session is idle.** Nothing is running, and the prompt box is empty. Typing anything holds it off.
- **Only a large conversation.** Below 50,000 tokens, reading the conversation uncached costs little, so it's left alone.
- **Once per pause.** After a compaction, nothing happens again until your next prompt.
- **Same model.** The cache belongs to one model, so after a `/model` switch there's nothing left to keep warm.

For the 30 seconds before it compacts, the status line under the prompt counts down: `⇊ compacting in 23s, before the cache goes cold · type to hold`.

When you come back, a line in the transcript tells you what happened, for example `Compacted at 14:32 (120k → 4k tokens), just before the prompt cache went cold.` That line is for you only: it isn't sent to the model. If the compaction found the cache already gone, the line says so, because then it saved nothing.

Whether your account caches for 5 minutes or an hour is learned from the requests themselves and remembered between sessions. Until a request shows otherwise, it assumes an hour, as a Claude subscription has.

Headless runs (`claude -p`) are left alone.

## Turning it off for a session

Two chips sit side by side on one row under the prompt, below the mode line, a row they share with the chips of any other mod that puts its own there:

```
⏸ manual mode on · ? for shortcuts
 on   Warm compact   off  Keep warm
```

Click `Warm compact` to turn it off for this session, and again to turn it back on. Turning it off during the countdown cancels it.

The same from the prompt:

```
/warm-compact        flips it
/warm-compact off    turns it off
/warm-compact on     turns it on
/warm-compact stats  shows what it saved
```

A new session, or a `/clear`, starts with it on.

## Keep warm: renew the cache instead

A compaction keeps your session cheap, but it trades the conversation for a summary. Keep warm keeps the whole conversation instead: a minute before the cache lapses, it renews it with one tiny request that re-reads the conversation from the cache. That request costs about a tenth of the conversation's size in tokens (a twentieth on Opus 5.5) and starts the cache's clock again. Coming back to a cold cache would cost twice its size.

It's off by default, because it spends tokens while you're away. Turn it on with the `Keep warm` chip, or from the prompt:

```
/keep-warm        flips it
/keep-warm on     turns it on
/keep-warm off    turns it off
```

- **It renews the cache at most twice per pause** (two hours on an hour-long cache), then warm compact takes over, if it's on. The `keepWarmRenewals` option changes how many times.
- **A renewal is invisible.** It adds nothing to the conversation and the model never sees it; a line in the transcript, `Kept the prompt cache warm at 14:32 (1 of 2).`, is for you. Text left in the prompt box doesn't hold it off.
- **Every renewal is checked.** If one finds the cache gone, warm compact takes over at once, while it's cheap to.
- **Some models can't be renewed.** On Sonnet 5.5, with Claude Code 2.1.289, the renewal request differs slightly from the session's own and misses the cache. Keep warm notices the first miss and leaves that model to warm compact until Claude Code updates.
- **How long a renewal holds the cache** is learned the first time you come back, or renew again, after one. If it turns out to be only 5 minutes on your account, keeping an hour-long cache warm would cost more than compacting, so keep warm stands down and says so.

Renewals count in `/warm-compact stats` too: each costs its request, and the last one before you come back is credited with the re-read it spared.

## What it saved

`/warm-compact stats` adds up what the compactions saved, for this session, the last 7 days and all time:

```
              compactions  renewals  came back  net saved
This session            1         0          1      +222k
Last 7 days             5         3          6      +1.4M
All time                9         5         11      +2.6M
```

Savings are counted in input tokens, the unit the API prices everything against: writing a token to an hour-long cache costs 2 of them (1.25 for a 5-minute cache), reading one from the cache 0.1 (0.05 on Opus 5.5, 0.025 on Fable 5.1), and generating one 5.

- **Once you come back** to a session, the compaction is credited with the re-read it spared you: the whole conversation written to the cache again. Against that it is charged its own request (reading the conversation from the cache and writing the summary) and writing the summary to the cache when you return.
- **A session you never come back to** is charged the compaction alone.
- Every request after your return reads a smaller conversation too. That saving is left out, so the tally errs low.

On a Claude subscription you don't pay per token, but the same tokens count toward your usage limits.

## Options

In `/config`, or in `~/.claude/settings.json` under `pluginConfigs`:

| Option | Default | What it does |
| --- | --- | --- |
| `minTokens` | 50000 | The smallest conversation it compacts, in tokens |
| `leadSeconds` | 60 | How long before the cache lapses a compaction or a renewal starts (15 at least) |
| `keepWarmRenewals` | 2 | With keep warm on, how many times the cache is renewed in one pause before warm compact takes over |

## Install

```sh
claude plugin marketplace add ziedgithub/claude-code-mods && claude plugin install warm-compact@zied-mods
```

Then restart Claude Code.

See the [repository README](../README.md) for running it from a clone.
