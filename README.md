# Claude Code mods

Two mods for [Claude Code](https://claude.com/claude-code). Mods are plugins that hook straight into the engine to draw their own UI.

| Mod | What it does |
| --- | --- |
| [**context-bar**](context-bar/) | A footer showing the model and effort, how full the context window is, and the prompt cache, with one-click compact and clear. |
| [**crab-buddy**](crab-buddy/) | A pixel-art Claude crab above the prompt that works, thinks, cheers and sleeps along with your session, plus a small crab in its own color for each subagent. |

![crab-buddy in action](docs/crab-buddy.gif)

![context-bar](docs/context-bar.png)

Each mod works on its own. Install one or both.

## Install

```sh
claude plugin marketplace add ziedgithub/claude-code-mods
claude plugin install context-bar@zied-mods
claude plugin install crab-buddy@zied-mods
```

Then restart Claude Code.

You can also run from inside Claude Code: `/plugin marketplace add ziedgithub/claude-code-mods`, then `/plugin install`.

Built and tested on Claude Code 2.1.289. Mods need a release recent enough to load function hooks (`hooks/hooks.json` with `modules`).

## Run from a clone

To hack on the mods, point Claude Code at the folders instead of installing them:

```sh
git clone https://github.com/ziedgithub/claude-code-mods.git ~/.claude/mods
```

Then, in `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/.claude/mods/context-bar:/Users/you/.claude/mods/crab-buddy"
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
