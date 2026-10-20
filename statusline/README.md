# Statusline

A two-row statusline command for Claude Code.

```
󰫆 Opus 5 ❯ my-project ⎇  feat/add-login-page
C 34% ▦1M · S 08%󰅀10 ↺04:06 · W 09%󰅀02 ↺6d 05:16
```

- Row 1: effort, model, folder and git branch.
- Row 2: context usage and window size; the 5-hour and weekly rate limits, each
  with its pace (usage minus elapsed time) and reset countdown.

Every part is colored by severity, and the pace glyphs carry direction and
severity on their own, so the row still reads without color. When the terminal
is too narrow, the least useful parts are dropped first. The script's comments
explain each threshold.

## Requirements

- `bash` (3.2 or newer), `jq` and `git`.
- A Claude subscription for the rate-limit groups. Without one they are left
  out.

## Install

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash /path/to/claude-kit/statusline/statusline-command.sh",
    "refreshInterval": 5
  }
}
```

`refreshInterval` keeps the reset countdowns current between events.

## Switches

Set these in your shell profile, or in the `env` block of
`~/.claude/settings.json` to reach the desktop app too. Switches take `yes`/`1`
or `no`/`0`; unset means off.

| Variable | Effect |
| --- | --- |
| `CLAUDE_CODE_STATUS_BAR_NERD_FONT` | Nerd Font icons for effort and pace. Off: glyphs every monospace font has |
| `CLAUDE_CODE_STATUS_BAR_MODEL_ABBR` | Shorten the model family to its initial: `Opus 5.5` becomes `O5.5` |
| `CLAUDE_CODE_SESSION_HEATING_SHOW_IN_STATUSLINE` | Show [Session Heating](../mods/session-heating)'s state after the model |
| `CLAUDE_CODE_SESSION_HEATING_NERD_FONT` | Nerd Font icons for that state (also needs `CLAUDE_CODE_STATUS_BAR_NERD_FONT`) |

## Session Heating icon

With `CLAUDE_CODE_SESSION_HEATING_SHOW_IN_STATUSLINE` on, the script reads
`~/.claude/session-heating/<session-id>.json`, which the Session Heating mod
writes, and shows its state after the model:

| State | Unicode | Nerd Font | Color |
| --- | --- | --- | --- |
| Hot: heating | `♨` | `md-radiator` | red (256-color 167) |
| Cold: heating stopped | `❆` | `md-snowflake` | sky (256-color 45) |
| Off: turned off for the session | `◌` | `md-radiator_off` | grey (256-color 242) |

Without the mod, no state file exists and no icon is shown.
