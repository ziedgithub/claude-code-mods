# crab-buddy

A pixel-art Claude crab lives in the band above the prompt and goes through your session with you. Each subagent gets a small crab of its own.

![crab-buddy in action](../docs/crab-buddy.gif)

## Moods

![The five moods, each small crab beside the big one](../docs/moods.png)

| Mood | When | What it does |
| --- | --- | --- |
| idle | between turns | blinks, glances left and right |
| working | while Claude works | types on a laptop with its logo glowing |
| thinking | while thinking streams | raises a claw beside a growing thought bubble |
| happy | for 5 seconds after an answer | jumps with its claws up, sparks flying |
| sleeping | after a minute with nothing to do | slumps, eyes shut, `z`s rising |

## Subagents

Every subagent gets a small crab, left of the big one, that lives through the same moods for its own agent:

- It works and thinks while its agent runs.
- It cheers once the agent is done, then leaves.
- It nods off after a minute of waiting.

Up to eight are drawn, and any more are counted as `+N`.

When a subagent messages the main conversation, or sends back its final report, a small envelope flies in an arc from its crab to the big one.

Each kind of agent has its own color, so you can tell at a glance what is running:

| Agent type | Color |
| --- | --- |
| general-purpose | blue |
| Explore | green |
| Plan | purple |
| claude-code-guide | yellow |
| statusline-setup | teal |
| claude | pink |
| a fork | the crab's own orange |

Any other type, such as one of your own agents or a plugin's, gets the next free color from a spare palette. That color is remembered across sessions, so the type keeps it.

The crab draws in the terminal only.

## Install

```sh
claude plugin marketplace add ziedgithub/claude-code-mods
claude plugin install crab-buddy@zied-mods
```

See the [repository README](../README.md) for running it from a clone.
