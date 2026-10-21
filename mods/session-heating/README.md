# Session Heating

A Claude Code mod that keeps a session's prompt cache warm while you're away.

On a Claude subscription, the main conversation's prompt cache lives one hour
from the start of the last request that read or wrote it. Coming back after
that hour means the whole conversation is written to the cache again, at 2× the
input price. Session Heating sends a small ping shortly before the hour runs
out, so the cache stays warm and your next prompt reads it instead.

## Requirement: `idleCompaction: false`

Claude Code's idle compaction compacts an idle session shortly before its cache
expires. That replaces the transcript with a summary, so the prefix Session
Heating keeps warm would never be read again. Turn it off in `settings.json`:

```json
{
  "idleCompaction": false
}
```

Your threshold auto-compaction (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) is not
affected. Session Heating checks this setting at session start and shows a toast
when it is missing.

## Install

In Claude Code:

```
/plugin install session-heating --marketplace markus-fuereder/claude-kit
```

Or from a shell:

```sh
claude plugin marketplace add markus-fuereder/claude-kit
claude plugin install session-heating@claude-kit
```

In the desktop app, where `/plugin` does not run: click + next to the prompt
box, then Plugins, Add marketplace with `markus-fuereder/claude-kit`, then Add
plugin.

Then run `/reload-plugins` or start a new session, and set `idleCompaction`
as described above.

## How it works

1. After each main-thread turn, a ping is scheduled 50 minutes after the start
   of the turn's last model request (the moment the cache TTL counts from).
2. The ping forks the session: the same request `/btw` makes, the session's own
   prefix plus one tool-less question. The reply never enters the transcript.
3. A ping that reads at least 90% of the last turn's cached prefix restarts the
   hour, and the next ping is scheduled 50 minutes after it.
4. Heating stops, and the cache is left to lapse, when:
   - a ping reads less than 90% (the cache was already gone),
   - more than an hour passed since the last refresh (the machine slept),
   - the hours cap is reached (12 hours away by default),
   - pings keep failing.

   After the cap or failed pings the cache is still warm until an hour after
   the last ping: the state stays hot until then, and turns cold when it lapses.
5. Any new prompt cancels the pending ping; the turn refreshes the cache itself.

Only sessions with a person at them heat: the terminal REPL, or a session with a
terminal or desktop surface attached. `-p` and SDK runs never heat.

While heating, `caffeinate -s` keeps the Mac from sleeping on AC power. On
battery it has no effect unless `CLAUDE_CODE_SESSION_HEATING_CAFFEINATE_ALSO_ON_BATTERY`
is on, which adds `-i` to hold off idle sleep there too.

## Command

| Command | Effect |
| --- | --- |
| `/session-heating` | Toggle heating for this session |
| `/session-heating on` | Turn it on |
| `/session-heating off` | Turn it off |

## Configuration

Set these in your shell profile for CLI sessions. The desktop app does not load
shell files: set them in the `env` block of `~/.claude/settings.json` to reach
both. A value in `settings.json` overrides the shell's.

Switches take `yes`/`1` or `no`/`0`. An invalid value falls back to the default
and shows a toast.

| Variable | Default | Effect |
| --- | --- | --- |
| `CLAUDE_CODE_SESSION_HEATING_MINUTES` | `50` | Ping interval in minutes, clamped to 29–59 |
| `CLAUDE_CODE_SESSION_HEATING_HOURS_CAP` | `12` | Stop after this many hours away, clamped to 1–32 |
| `CLAUDE_CODE_SESSION_HEATING_CAFFEINATE` | `yes` | Keep the Mac awake while heating, on AC power only (`caffeinate -s`) |
| `CLAUDE_CODE_SESSION_HEATING_CAFFEINATE_ALSO_ON_BATTERY` | `no` | Also hold off idle sleep on battery (`caffeinate -i -s`) |
| `CLAUDE_CODE_SESSION_HEATING_NERD_FONT` | `no` | Nerd Font icons (the statusline also needs `CLAUDE_CODE_STATUS_BAR_NERD_FONT=yes`) |
| `CLAUDE_CODE_SESSION_HEATING_SHOW_IN_STATUSLINE` | `no` | Icon after the model in the statusline |
| `CLAUDE_CODE_SESSION_HEATING_SHOW_ABOVE_PROMPT` | `yes` | Band above the prompt while you're away |
| `CLAUDE_CODE_SESSION_HEATING_SHOW_ABOVE_PROMPT_PERMANENTLY` | `no` | Show the band all the time, also during a turn and the 5 minutes after it |
| `CLAUDE_CODE_SESSION_HEATING_ABOVE_PROMPT_SHOW_OFF` | `yes` | Show the band while heating is off for the session; `no` draws nothing then |
| `CLAUDE_CODE_SESSION_HEATING_ABOVE_PROMPT_COMPACT` | `no` | Compact band instead of the full line |
| `CLAUDE_CODE_SESSION_HEATING_RELATIVE_TIME` | `yes` | Times in the band as spans (`ping in 12m`); `no` shows clock times (`ping at 14:52`) |
| `CLAUDE_CODE_SESSION_HEATING_24H_CLOCK` | `yes` | Clock times on a 24-hour clock (`14:52`); `no` shows a 12-hour clock (`2:52pm`) |
| `CLAUDE_CODE_SESSION_HEATING_SHOW_TOAST` | `yes` | Toasts when heating stops and on invalid settings |

The mod reads these when a session starts and on `/reload-plugins`. A change in
`settings.json` reaches a running session on `/reload-plugins`; a change in the
shell profile reaches only CLI sessions started from a shell that loaded it.

### Variables

#### `CLAUDE_CODE_SESSION_HEATING_MINUTES`

Default `50`. Minutes from the start of the last request that read or wrote the
cache to the next ping. A whole number, clamped to 29–59: a ping must land
inside the one-hour cache lifetime. A lower value leaves more room for a late
ping, and costs more pings over the same time away.

#### `CLAUDE_CODE_SESSION_HEATING_HOURS_CAP`

Default `12`. Hours after the end of the last turn during which pings are sent.
A whole number, clamped to 1–32. No ping is sent past the cap. The cache then
stays warm until an hour after the last ping: the band shows
`session warm for ~48m · pings capped`, and turns cold when the cache lapses.
With the defaults, 12 hours away is at most 14 pings.

#### `CLAUDE_CODE_SESSION_HEATING_CAFFEINATE`

Default `yes`. Runs `caffeinate -s` while heating, so the Mac does not go to
sleep on AC power and miss a ping. It stops when a turn starts, after the last
ping before the cap, and when heating goes cold or is turned off. On battery
`-s` has no effect. Without `caffeinate` on the machine, heating goes on
without it.

#### `CLAUDE_CODE_SESSION_HEATING_CAFFEINATE_ALSO_ON_BATTERY`

Default `no`. Adds `-i` to `caffeinate`, which holds off idle sleep on battery
too. The Mac then stays awake on battery for up to the hours cap. Only takes
effect with `CLAUDE_CODE_SESSION_HEATING_CAFFEINATE` on.

#### `CLAUDE_CODE_SESSION_HEATING_NERD_FONT`

Default `no`. Nerd Font icons in the band (`md-radiator`, `md-snowflake`,
`md-radiator_off`) instead of the Unicode ones (`♨`, `❆`, `◌`). The band uses
them in the terminal only; the desktop app always shows the Unicode ones. The
statusline in this repo also reads this variable, together with
`CLAUDE_CODE_STATUS_BAR_NERD_FONT=yes`.

#### `CLAUDE_CODE_SESSION_HEATING_SHOW_IN_STATUSLINE`

Default `no`. Read by the statusline in this repo, not by the mod: with `yes`
or `1` it shows the state icon after the model. The statusline takes no other
values and shows no toast for them.

#### `CLAUDE_CODE_SESSION_HEATING_SHOW_ABOVE_PROMPT`

Default `yes`. Draws the band above the prompt. With `no` the mod draws nothing
there; heating itself goes on. To show the band in the desktop app but not in
the CLI, leave this out of `settings.json` and set `no` in the shell profile:
a value in `settings.json` would override the shell's.

#### `CLAUDE_CODE_SESSION_HEATING_SHOW_ABOVE_PROMPT_PERMANENTLY`

Default `no`: the band shows only while you're away, hidden during a turn and
for 5 minutes after it. With `yes` it shows all the time. During a turn, which
writes the cache itself, it reads `session warm` with no time or detail. Before
the first turn of a session it shows nothing either way: there is no cache yet.

#### `CLAUDE_CODE_SESSION_HEATING_ABOVE_PROMPT_SHOW_OFF`

Default `yes`: while heating is off for the session (`/session-heating off`),
the band reads `session heating off`. With `no` it draws nothing then. The
statusline icon is not affected.

#### `CLAUDE_CODE_SESSION_HEATING_ABOVE_PROMPT_COMPACT`

Default `no`. With `yes` the band shows the state and its time only
(`warm for 11h 50m`, `cold for 2h 5m`, `off`), without `session` and without
the detail at the right end.

#### `CLAUDE_CODE_SESSION_HEATING_RELATIVE_TIME`

Default `yes`: times in the band are spans from now (`ping in 12m`,
`for 11h 50m`, `cold for 2h 5m`), redrawn the moment they change. With `no`
they are clock times (`ping at 14:52`, `until 02:30`, `since 12:35`).

#### `CLAUDE_CODE_SESSION_HEATING_24H_CLOCK`

Default `yes`: clock times on a 24-hour clock (`14:52`). With `no` a 12-hour
clock (`2:52pm`). Only takes effect with
`CLAUDE_CODE_SESSION_HEATING_RELATIVE_TIME=no`.

#### `CLAUDE_CODE_SESSION_HEATING_SHOW_TOAST`

Default `yes`. Toasts when heating stops (a cache miss, the machine slept, the
hours cap, failed pings), when a setting is invalid, and when `idleCompaction`
is not `false`. With `no` none of them shows.

## Display

| State | Unicode | Nerd Font | Color |
| --- | --- | --- | --- |
| Hot: the cache is warm, heating or not | `♨` | `md-radiator` | red (256-color 167) |
| Cold: heating stopped and the cache lapsed | `❆` | `md-snowflake` | sky (256-color 45) |
| Off: turned off for this session | `◌` | `md-radiator_off` | grey (256-color 242) |

The band above the prompt shows only while you're away: it is hidden during a
turn and for 5 minutes after it. With
`CLAUDE_CODE_SESSION_HEATING_SHOW_ABOVE_PROMPT_PERMANENTLY=yes` it shows all the
time; during a turn, which writes the cache itself, it reads `session warm`
with no time or detail. It redraws the moment a countdown shows a
new minute, so its countdowns stay current.

| State | Relative (default) | Clock times |
| --- | --- | --- |
| Hot | `♨ session warm for 11h 50m · ping in 12m` | `♨ session warm until 02:30 · ping at 14:52` |
| Hot, no more pings | `♨ session warm for ~48m · pings capped` | `♨ session warm until ~15:28 · pings capped` |
| Cold | `❆ session cold for 2h 5m · machine slept` | `❆ session cold since 12:35 · machine slept` |
| Off | `◌ session heating off` | `◌ session heating off` |

The examples are at 14:40, with clock times on the 24-hour clock. The full band
puts the part after `·` at its right end, across the width of the prompt.

The reasons are `pings capped` and `pings failed` while hot, and `machine
slept`, `cache miss` and `pings failed` once cold. A cold band after the cap
names no reason. With `CLAUDE_CODE_SESSION_HEATING_ABOVE_PROMPT_SHOW_OFF=no`
the off band draws nothing.

The compact band shows the state and its time only: `♨ warm for 11h 50m`,
`❆ cold for 2h 5m`, `◌ off`.

In the warm band, "for" and "until" give when the cache lapses if every ping
until the hours cap reads it: an hour after the last one. After the cap or
failed pings, a `~` marks it as an estimate: cache entries are not documented
to live the full hour.

The mod writes the state to `~/.claude/session-heating/<session-id>.json`
(`{"state":"hot"}`, `"cold"` or `"off"`). The statusline in this repo
(`statusline/`) reads that file to show the icon after the model. Any other
statusline command can do the same: it gets `session_id` in the JSON on stdin.

## Cost

Each ping is a cache read of the whole conversation plus a few output tokens:
0.05× the base input price on Opus 5.5 and Sonnet 5.5, 0.025× on Fable 5.1 and
0.1× on other models. A cold restart costs a 2× cache write. With the defaults,
12 hours away is at most 14 pings. Every open session heats on its own, so a
session you never return to still pays for its pings until the cap.

## Known limits

- Pings use Claude Code's fork request, which runs in the 5-minute cache bucket.
  It is not documented whether such a read keeps the main conversation's
  one-hour entry alive for a full hour. If it doesn't, the second ping misses
  and heating stops after one cache rewrite.
- Cache entries are not documented to live the full TTL. An early eviction shows
  up as a miss.
- With `CLAUDE_CODE_SESSION_HEATING_CAFFEINATE_ALSO_ON_BATTERY=yes`, the Mac stays
  out of idle sleep on battery for up to the hours cap per heating session.
