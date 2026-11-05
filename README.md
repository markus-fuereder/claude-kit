# claude-kit

Mods and a statusline for Claude Code. A personal collection, not an official
Anthropic project.

| Part | What it is | Docs |
| --- | --- | --- |
| [Session Heating](mods/session-heating) | A mod that keeps a session's prompt cache warm while you're away | [README](mods/session-heating/README.md) |
| [astack](https://github.com/markus-fuereder/astack) | A plugin: the agentic engineering harness (decision interviews, planning gates, an independent code gate), in its own repository | [README](https://github.com/markus-fuereder/astack#readme) |
| [Statusline](statusline) | A two-row statusline command: model, effort, folder, branch, context, rate limits and pace | [README](statusline/README.md) |

The two work on their own. Together, the statusline shows Session Heating's
state as an icon after the model.

## Install

### Session Heating

In Claude Code:

```
/plugin install session-heating --marketplace markus-fuereder/claude-kit
```

Session Heating needs `"idleCompaction": false` in `~/.claude/settings.json`.
See its [README](mods/session-heating/README.md) for why and for its settings.

### astack

astack lives in its own repository; this marketplace pins its release. The repository is private for now, so installing needs read access to it. See the astack README for the team-workspace install at project scope.

```sh
claude plugin marketplace add markus-fuereder/claude-kit
```

```sh
claude plugin install astack@claude-kit
```

### Statusline

Clone the repo and point Claude Code's `statusLine` setting at the script:

```sh
git clone https://github.com/markus-fuereder/claude-kit.git ~/claude-kit
```

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash ~/claude-kit/statusline/statusline-command.sh",
    "refreshInterval": 5
  }
}
```

See the statusline [README](statusline/README.md) for its switches.

## Layout

```
claude-kit/
├── .claude-plugin/marketplace.json   # lists the mods
├── mods/
│   └── session-heating/              # one plugin per folder
└── statusline/
    └── statusline-command.sh
```

## Developing a mod

Point a local marketplace at your clone, so edits load with `/reload-plugins`
and need no push:

```sh
claude plugin marketplace add ~/claude-kit
claude plugin install session-heating@claude-kit
```

Check a mod before committing:

```sh
claude plugin validate mods/session-heating
claude plugin test mods/session-heating
```

## License

[MIT](LICENSE)
