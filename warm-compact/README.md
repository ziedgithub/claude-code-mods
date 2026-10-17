# warm-compact

Compacts an idle session just before its prompt cache goes cold, or keeps the cache warm while you're away.

It is separate from Claude Code's own auto-compact, which compacts when the context window fills up. warm-compact acts on time instead: it compacts when you've been away long enough for the cache to lapse, even when the window is far from full.

Recent Claude Code versions also compact an idle session on their own, about 54 minutes into an hour-long cache. That would compact before warm compact's turn, and whatever keep warm did: a keep warm renewal doesn't count as a new request for it. So the first time warm-compact starts, it turns Claude Code's idle compaction off, by adding `"idleCompaction": false` to your user settings (`~/.claude/settings.json`), and says so in the transcript. If you set it to `false` yourself, or a policy does, it's left as it is; a project's own setting speaks for that project only, so your user settings are still written. If the file can't be read or written, it's left alone and tried again next session. It does this once: turn idle compaction back on afterwards, with the toggle in `/config` or in the file, and it stays on. Uninstalling warm-compact doesn't put it back: remove the line to have Claude Code's own idle compaction again.

Claude Code caches the conversation for 5 minutes or an hour after each request, depending on your account. If you come back after that, your next prompt re-reads the whole conversation uncached, which is the most expensive way to read it. warm-compact compacts the session a minute before the cache lapses, while the compaction itself can still read the conversation from the cache. Your next prompt then starts from a short summary.

## When it compacts

- **Only when the session is idle.** Nothing is running, the prompt box is empty, and you haven't typed in it, or emptied it, for a minute, as with Claude Code's own idle compaction. Typing anything holds it off; once you stop, it waits that minute, counts down again, and compacts if the cache still holds by then.
- **Only a large conversation.** Below 50,000 tokens, reading the conversation uncached costs little, so it's left alone.
- **Only with auto-compact on.** If you've turned Claude Code's auto-compact off, warm compact leaves the session alone too, and says so once. It's checked when a compaction comes due and again as it starts, so turning auto-compact off during a pause counts.
- **Not near a rate limit.** When 90% or more of a usage limit is used (the five-hour or the weekly one, or a gateway's spend limit), a compaction or a renewal would spend what you have left, so that pause is left alone, with a line in the transcript saying so. The figures are the last response's; a limit that has reset since doesn't count.
- **Once per pause.** After a compaction, nothing happens again until your next prompt.
- **After anyone's compaction.** Your `/compact`, or Claude Code's own, starts the wait over. Where an organization manages Claude Code, plugins are not told of a compaction: warm-compact still leaves the compacted conversation alone until your next prompt, and doesn't take its first, uncached read for a sign of a short cache.
- **Same model.** The cache belongs to one model, so after a `/model` switch there's nothing left to keep warm.
- **Not after a sleep.** If the computer slept, or Claude Code stalled, while you were away, the cache may have lapsed meanwhile, so that pause is left alone and a line in the transcript says so.

For the 30 seconds before it compacts, the status line under the prompt counts down: `⇊ compacting in 23s, before the cache goes cold · type to hold`.

When you come back, a line in the transcript tells you what happened, for example `Compacted at 14:32 (120k → 4k tokens), just before the prompt cache went cold.` That line is for you only: it isn't sent to the model. If the compaction found the cache already gone, the line says so, because then it saved nothing.

**Two of those in a row and warm compact stands down** until Claude Code updates, and says so, once it knows how long your account caches (until then, a compaction finding the cache gone may only mean a 5-minute cache): on some Claude Code versions the compaction misses a cache that is still warm, so every compaction would cost a full re-read. While it stands down its chip shows off: `/warm-compact on`, or a click on the chip, tries again. Each Claude Code version counts its own misses, so a session still on an older version after an update doesn't reset the newer one's count.

**The cache duration Claude Code is set to comes first.** Claude Code caches the conversation for an hour on a Claude subscription within its usage limits, and for 5 minutes otherwise, renewing those 5 minutes on its own for an hour after you were last active. Compactions can't read a cache kept alive that way, so the hour is what warm-compact needs. You can pick it with `"promptCacheTtl": "1h"` in `~/.claude/settings.json`; 1-hour cache writes cost more than 5-minute ones. warm-compact reads that setting, and the `CLAUDE_CODE_PROMPT_CACHE_TTL` and `FORCE_PROMPT_CACHING_5M` variables that override it:

- **An hour picked:** warm-compact knows the duration, with nothing to learn.
- **5 minutes picked:** warm-compact stands down for as long as it stays picked, and says why when a compaction would have come.
- **Nothing picked:** it learns the duration as below, and a stand-down after two missed compactions suggests the setting.

Changing the setting starts the missed compactions over.

Whether your account caches for 5 minutes or an hour is learned from the requests themselves and remembered between sessions: the first request after a pause of 6 to 59 minutes shows it, and two such pauses in a row must agree before it changes. A compaction or a renewal that still finds the cache warm 59 minutes on shows an hour too. Until they do, it assumes an hour, as a Claude subscription has.

Headless runs (`claude -p`) are left alone.

With [context-bar](../context-bar/) installed, a mark after its cache countdown says what warm-compact will do if you stay away: `⇊` for a compaction, `♨` for a keep warm renewal. Hover it to see when. context-bar also counts down on the cache duration warm-compact learned, so the two always agree.

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

A new session, a `/clear` or a `/resume` starts with it on, and with keep warm off.

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
- **Every renewal is checked.** One that fails (an API error, a dropped connection) says nothing about the cache: warm compact takes over at once (if it's on, and auto-compact too), and keep warm tries again next pause. One that finds the cache gone wrote the conversation back to it itself, for five minutes at least: warm compact takes over a minute before that copy lapses. Either way, the compaction waits for you as its own does when you're typing, and if the cache lapses first it's dropped, with a line in the transcript saying so. A renewal that a prompt of yours overtakes only counts its cost.
- **Some models can't be renewed.** On Sonnet 5.5, with Claude Code 2.1.289, the renewal request differs slightly from the session's own and misses the cache. Keep warm notices the first miss and leaves that model to warm compact until Claude Code updates (once it knows how long your account caches, as above).
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
| `leadSeconds` | 60 | How long before the cache lapses a compaction or a renewal starts (20 at least) |
| `keepWarmRenewals` | 2 | With keep warm on, how many times the cache is renewed in one pause before warm compact takes over |

## Install

```sh
claude plugin marketplace add ziedgithub/claude-code-mods && claude plugin install warm-compact@zied-mods
```

Needs Claude Code 2.1.296 or later.

Then restart Claude Code.

See the [repository README](../README.md) for running it from a clone.
