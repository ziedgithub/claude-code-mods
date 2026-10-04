# Claude Code mods

Three mods for [Claude Code](https://claude.com/claude-code). Mods are plugins that hook straight into the engine to draw their own UI.

## Install

Paste this in your terminal:

```sh
claude plugin marketplace add ziedgithub/claude-code-mods && claude plugin install context-bar@zied-mods && claude plugin install crab-buddy@zied-mods && claude plugin install warm-compact@zied-mods
```

Then restart Claude Code. That's it.

<details>
<summary>Only want one of them, or prefer to do it from inside Claude Code?</summary>

Inside Claude Code, type:

```
/plugin marketplace add ziedgithub/claude-code-mods
/plugin install crab-buddy@zied-mods
/plugin install context-bar@zied-mods
/plugin install warm-compact@zied-mods
```

Skip any `install` line to leave that mod out, then restart Claude Code.

</details>

**Update** to the latest version, then restart:

```sh
claude plugin marketplace update zied-mods && claude plugin update context-bar@zied-mods && claude plugin update crab-buddy@zied-mods && claude plugin update warm-compact@zied-mods
```

**Remove**: `claude plugin uninstall crab-buddy@zied-mods` (or `context-bar@zied-mods`, `warm-compact@zied-mods`).

Needs a recent Claude Code: built and tested on 2.1.289.

## What's inside

| Mod | What it does |
| --- | --- |
| [**context-bar**](context-bar/) | A footer showing the model and effort, how full the context window is, and the prompt cache, with one-click compact and clear. |
| [**crab-buddy**](crab-buddy/) | A pixel-art Claude crab above the prompt that works, thinks, cheers and sleeps along with your session, plus a small crab in its own color for each subagent. |
| [**warm-compact**](warm-compact/) | Compacts an idle session a minute before its prompt cache goes cold, so your next prompt starts from a short summary instead of re-reading the whole conversation uncached. A chip in the footer turns it off for the session. |

![crab-buddy in action](docs/crab-buddy.gif)

![context-bar](docs/context-bar.png)

Each mod works on its own. Install any of them.

## Run from a clone

To hack on the mods, point Claude Code at the folders instead of installing them:

```sh
git clone https://github.com/ziedgithub/claude-code-mods.git ~/.claude/mods
```

Then, in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/.claude/mods/context-bar:/Users/you/.claude/mods/crab-buddy:/Users/you/.claude/mods/warm-compact"
  }
}
```

Paths are absolute and separated by `:` (`;` on Windows). For a single session, use `claude --plugin-dir <folder>` instead. Claude Code watches these folders and reloads a mod when you save one of its files. Don't also install the same mod from the marketplace, or its hooks run twice.

## Develop

```sh
claude plugin validate crab-buddy        # what the mod hooks and calls, and anything the engine would refuse
claude plugin test crab-buddy            # the mod's *.test.ts against the engine
npx -p typescript tsc -p crab-buddy      # type-check
```

Type-checking needs `.claude-plugin/types/` inside the mod. Claude Code writes that folder the first time it loads the mod, and it is git-ignored.

## License

[MIT](LICENSE)
