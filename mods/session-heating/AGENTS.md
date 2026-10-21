# Session Heating

## Environment variables

When you add, rename or remove a `CLAUDE_CODE_SESSION_HEATING_*` variable, or
change its default or values, update in the same change:

- `loadConfig` in `hooks/register.tsx`: the variable, its default, and how an
  invalid value warns (`flag` for yes/no switches, `whole` for numbers).
- The table under "Configuration" in `README.md`: one row with the variable,
  its default and a one-line effect.
- The "Variables" section in `README.md`: a `####` heading named after the
  variable, giving its default, each value and what it does, and how it
  interacts with other variables.
- `statusline/README.md` and `statusline/statusline-command.sh`, when the
  statusline reads the variable too.

Keep the table and the "Variables" section in the same order.

## Band text

When you change what the band above the prompt says, update in the same change
the "Display" section in `README.md` and the expected strings in
`tests/heating.test.ts`.

## Before committing

Once the user gives the go-ahead to commit, run both checks first, and commit
only when they pass:

```sh
claude plugin validate mods/session-heating
claude plugin test mods/session-heating
```

Bump `version` in `.claude-plugin/plugin.json` in every commit that changes
the mod. Installed copies of the plugin update only when the version changes.

- Text only (band wording, toasts, docs shipped with the mod): patch, `0.3.0`
  to `0.3.1`.
- Behavior (what the mod does, a new or changed setting): minor, `0.3.0` to
  `0.4.0`.
