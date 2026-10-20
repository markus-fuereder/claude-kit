#!/usr/bin/env bash
# Claude Code status line — two rows.
#
#   󰫆 Opus 5 ❯ my-project ⎇  feat/add-login-page
#   C 34% ▦1M · S 08%󰅀10 ↺04:06 · W 09%󰅀02 ↺6d 05:16
#
#   row 1  effort model ❯ folder ⎇  branch
#   row 2  context usage and window size · 5-hour pace, limit and reset
#          countdown · weekly pace, limit and reset countdown
#
# Runs on every assistant message, /compact, permission-mode change and vim-mode
# toggle (debounced 300ms), plus the settings.json refreshInterval tick — which
# the countdowns need to stay true. Claude Code cancels an in-flight script when
# the next update fires, so this stays cheap: one jq fork for all parsing,
# formatting and countdown arithmetic, one git fork, everything else builtins.
#
# Row 1 is elided to fit before anything else happens: when row 1 overruns the
# terminal Claude Code truncates it and discards every row below, so a too-long
# branch name would silently take the whole context bar with it.

input=$(cat)

# Session Heating writes its state to ~/.claude/session-heating/<session_id>.json.
# CLAUDE_CODE_SESSION_HEATING_SHOW_IN_STATUSLINE=1 (or yes) shows it; unset, 0 or
# no hides it. The session id is matched with a bash regex so no extra jq fork
# is needed, and the file joins the one jq pass through --slurpfile only when it
# exists.
heat_args=(--argjson heat '[]')
if [[ $CLAUDE_CODE_SESSION_HEATING_SHOW_IN_STATUSLINE == 1 || $CLAUDE_CODE_SESSION_HEATING_SHOW_IN_STATUSLINE == yes ]] \
  && [[ $input =~ \"session_id\":\ *\"([^\"]+)\" ]] \
  && [ -f "$HOME/.claude/session-heating/${BASH_REMATCH[1]}.json" ]; then
  heat_args=(--slurpfile heat "$HOME/.claude/session-heating/${BASH_REMATCH[1]}.json")
fi

# ── parse, format and count down in a single jq pass ─────────────────────────
# Fields are '|'-separated: '|' is not IFS whitespace, so empty fields survive
# `read` intact (tab and newline would collapse into one separator).
read_fields=$(jq -r "${heat_args[@]}" '
  def p2: tostring | if length < 2 then "0" + . else . end;
  def pct: if . == null then "" else (round | tostring) end;
  def countdown:
    if . == null then "" else
      ((. - now) | floor | if . < 0 then 0 else . end) as $s
      | ($s / 86400 | floor) as $d
      | (($s % 86400) / 3600 | floor) as $h
      | (($s % 3600) / 60 | floor) as $m
      | (if $d > 0 then "\($d)d " else "" end) + ($h | p2) + ":" + ($m | p2)
    end;
  # Pace: quota consumed minus window time elapsed. Positive means burning
  # faster than the clock, negative means slower. Computed per window, so the
  # 5-hour and weekly limits each carry their own.
  def pace($span):
    .used_percentage as $u
    | .resets_at as $r
    | if $u == null or $r == null then "" else
        ((($span - ($r - now)) / $span * 100)
          | if . < 0 then 0 elif . > 100 then 100 else . end) as $e
        | (($u - $e) | round | tostring)
      end;
  [ ((.model.display_name // "") | sub("^[Cc]laude ";"") | sub(" *\\([^)]*\\)$";""))
  , ( .context_window.context_window_size
      | if . == null then ""
        elif . >= 1000000 then "\(./1000000 | round)M"
        else "\(./1000 | round)K" end )
  , (.context_window.used_percentage      | pct)
  , (.rate_limits.five_hour.used_percentage | pct)
  , (.rate_limits.seven_day.used_percentage | pct)
  , (.rate_limits.five_hour.resets_at     | countdown)
  , (.rate_limits.seven_day.resets_at     | countdown)
  , (.rate_limits.five_hour // {} | pace(18000))
  , (.rate_limits.seven_day // {} | pace(604800))
  , ((.workspace.current_dir // .cwd // "") | split("/") | last // "")
  , (.workspace.current_dir // .cwd // "")
  , (.effort.level // "")
  , ($heat[0].state // "")
  ] | join("|")' <<<"$input")

IFS='|' read -r model size ctx_pct five_pct week_pct five_cd week_cd \
  pace5 paceW folder cwd effort heat \
  <<<"$read_fields"

# CLAUDE_CODE_STATUS_BAR_MODEL_ABBR=yes (or 1) shortens the family name to its initial:
# "Opus 5.5" -> "O5.5". A name without a version is left as is.
[[ $CLAUDE_CODE_STATUS_BAR_MODEL_ABBR == yes || $CLAUDE_CODE_STATUS_BAR_MODEL_ABBR == 1 ]] && [[ $model == *" "* ]] \
  && model="${model:0:1}${model#* }"

# CLAUDE_CODE_STATUS_BAR_NERD_FONT=yes (or 1) draws the effort and pace icons from Nerd
# Font glyphs. Anything else, unset included, falls back to glyphs every
# monospace font carries, so the row renders on a machine without a Nerd Font.
NERD=no
[[ $CLAUDE_CODE_STATUS_BAR_NERD_FONT == yes || $CLAUDE_CODE_STATUS_BAR_NERD_FONT == 1 ]] && NERD=yes

# ── colours (256-colour ANSI) ────────────────────────────────────────────────
MAGENTA='\033[38;5;135m'
CYAN='\033[38;5;74m'
# below-pace ramp A: cyan -> blue -> indigo, all xterm cube colours
SKY='\033[38;5;45m'
CORN='\033[38;5;75m'
INDIGO='\033[38;5;61m'
GREEN='\033[38;5;71m'
YELLOW='\033[38;5;179m'
ORANGE='\033[38;5;208m'
RED='\033[38;5;167m'
GREY='\033[38;5;242m'
DIM='\033[38;5;242m'
RESET='\033[0m'

DOT="${DIM} · ${RESET}"      # neutral separator
ARR="${DIM} ❯ ${RESET}"      # drill-down: model into its workspace
BRA="${DIM} ⎇  ${RESET}"     # branch marker, 4 cols: U+2387 sits tight
                             # against the name without the extra space
RST="${DIM}↺${RESET}"        # U+21BA reset-countdown marker

# ── git branch ───────────────────────────────────────────────────────────────
# symbolic-ref reads .git/HEAD only — no index or worktree scan, so no cache is
# needed. It also resolves an unborn branch, which rev-parse HEAD cannot.
# fsmonitor stays off to avoid waking a watchman daemon per tick.
branch=""
if [ -d "$cwd" ]; then
  branch=$(git -C "$cwd" -c core.fsmonitor=false symbolic-ref --short HEAD 2>/dev/null) \
    || branch=$(git -C "$cwd" -c core.fsmonitor=false rev-parse --short HEAD 2>/dev/null)
fi

# Claude Code exports COLUMNS (v2.1.153+). Never probe /dev/tty: the script has
# no controlling terminal, so the probe fails and clobbers a correct COLUMNS.
budget=$(( ${COLUMNS:-80} - 1 ))

# Widths are counted in characters. Everything measured with ${#...} is ASCII,
# so the count is exact in any locale; the multi-byte pieces ('·', '❯', '⎇',
# the reset marker and the pace glyphs) are counted from known lengths
# instead.

grade() {   # grade <pct> <yellow-at> <orange-at> <red-at> -> $COL
  if   [ "$1" -ge "$4" ]; then COL=$RED
  elif [ "$1" -ge "$3" ]; then COL=$ORANGE
  elif [ "$1" -ge "$2" ]; then COL=$YELLOW
  else COL=$GREEN
  fi
}

# ── row 1: effort model ❯ folder ⎇  branch ────────────────────────────────────
# Effort fills a hexagon slice by slice, starting at slice 2 — slice 1 is thin
# enough to misread as empty. Claude Code omits effort.level when the model has
# no effort parameter; the icon then drops out. The icon binds to the model
# name, so if the name goes the icon goes with it. Without a Nerd Font, the
# level is counted in dots instead, one to five.
if [ "$NERD" = yes ]; then
  case $effort in
    low)    EFF_ICON='󰫄' ;;   # md-hexagon_slice_2
    medium) EFF_ICON='󰫅' ;;   # md-hexagon_slice_3
    high)   EFF_ICON='󰫆' ;;   # md-hexagon_slice_4
    xhigh)  EFF_ICON='󰫇' ;;   # md-hexagon_slice_5
    max)    EFF_ICON='󰫈' ;;   # md-hexagon_slice_6
    *)      EFF_ICON='' ;;
  esac
else
  case $effort in
    low)    EFF_ICON='·' ;;   # U+00B7 middle dot
    medium) EFF_ICON='∶' ;;   # U+2236 ratio
    high)   EFF_ICON='⁖' ;;   # U+2056 three dot punctuation
    xhigh)  EFF_ICON='⁘' ;;   # U+2058 four dot punctuation
    max)    EFF_ICON='⁙' ;;   # U+2059 five dot punctuation
    *)      EFF_ICON='' ;;
  esac
fi

# Session Heating icon, after the model: hot (red), cold (sky), off (grey).
# Nerd Font glyphs need both CLAUDE_CODE_STATUS_BAR_NERD_FONT=yes (or 1) and
# CLAUDE_CODE_SESSION_HEATING_NERD_FONT=1 (or yes). Otherwise the Unicode set is
# used: all three are single-column in a Western locale, so the width count
# holds. Like the effort icon, it binds to the model name and goes with it.
HEAT_ICON=''; HEAT_COL=''
HEAT_NERD=no
[ "$NERD" = yes ] && [[ $CLAUDE_CODE_SESSION_HEATING_NERD_FONT == 1 || $CLAUDE_CODE_SESSION_HEATING_NERD_FONT == yes ]] && HEAT_NERD=yes
case $heat in
  hot)  HEAT_COL='\033[38;5;167m'; [ "$HEAT_NERD" = yes ] && HEAT_ICON='󰐸' || HEAT_ICON='♨' ;;  # md-radiator / U+2668
  cold) HEAT_COL='\033[38;5;45m';  [ "$HEAT_NERD" = yes ] && HEAT_ICON='󰜗' || HEAT_ICON='❆' ;;  # md-snowflake / U+2746
  off)  HEAT_COL='\033[38;5;242m'; [ "$HEAT_NERD" = yes ] && HEAT_ICON='󰫘' || HEAT_ICON='◌' ;;  # md-radiator_off / U+25CC
esac

r1_width() {
  R1W=0
  [ -n "$model" ]  && R1W=$(( R1W + ${#model}${EFF_ICON:+ + 2}${HEAT_ICON:+ + 2} ))
  [ -n "$folder" ] && { [ "$R1W" -gt 0 ] && R1W=$(( R1W + 3 )); R1W=$(( R1W + ${#folder} )); }
  [ -n "$branch" ] && { [ "$R1W" -gt 0 ] && R1W=$(( R1W + 4 )); R1W=$(( R1W + ${#branch} )); }
}

r1_width
# Shorten the branch from the tail — ticket IDs and prefixes live at the head.
while [ "$R1W" -gt "$budget" ] && [ "${#branch}" -gt 8 ]; do
  keep=$(( ${#branch} - (R1W - budget) - 1 ))
  [ "$keep" -lt 7 ] && keep=7
  branch="${branch:0:$keep}~"
  r1_width
done
[ "$R1W" -gt "$budget" ] && { folder=""; r1_width; }
[ "$R1W" -gt "$budget" ] && { model="";  r1_width; }

row1=""
[ -n "$model" ]  && row1="${EFF_ICON:+${MAGENTA}${EFF_ICON}${RESET} }${MAGENTA}${model}${RESET}${HEAT_ICON:+ ${HEAT_COL}${HEAT_ICON}${RESET}}"
if [ -n "$folder" ]; then
  [ -n "$row1" ] && row1="${row1}${ARR}"
  row1="${row1}${CYAN}${folder}${RESET}"
fi
if [ -n "$branch" ]; then
  [ -n "$row1" ] && row1="${row1}${BRA}"
  row1="${row1}${GREY}${branch}${RESET}"
fi

# ── row 2: C ctx% ▦size · S five% chevron pace ↺reset · W … ↺reset ──
#
# Pace glyphs carry direction and, by chevron count, severity — deliberately
# redundant with the colour so the row still reads under colourblindness, glare
# on a phone screen, or a theme that mangles 256-colour violet. The value is
# printed unsigned and without a unit. Swap these to change the glyph set.
# Without a Nerd Font, triangles grow from small outline to large solid instead.
if [ "$NERD" = yes ]; then
  PACE_UP_3='󰶼'    # md-chevron_triple_up   — far over pace    (red)
  PACE_UP_2='󰄿'    # md-chevron_double_up   — well over pace   (orange)
  PACE_UP_1='󰅃'    # md-chevron_up          — over pace        (yellow)
  PACE_TARGET='󰇼'  # md-equal               — exactly on pace   (green)
  PACE_DN_1='󰅀'    # md-chevron_down        — under pace       (sky 45)
  PACE_DN_2='󰄼'    # md-chevron_double_down — well under pace  (cornflower 75)
  PACE_DN_3='󰶹'    # md-chevron_triple_down — far under pace   (indigo 61)
else
  PACE_UP_3='▲'    # U+25B2 black up triangle
  PACE_UP_2='▴'    # U+25B4 small black up triangle
  PACE_UP_1='▵'    # U+25B5 small white up triangle
  PACE_TARGET='='  # U+003D equals sign
  PACE_DN_1='▿'    # U+25BF small white down triangle
  PACE_DN_2='▾'    # U+25BE small black down triangle
  PACE_DN_3='▼'    # U+25BC black down triangle
fi
CTX_ICON='▦'       # U+25A6 square with orthogonal crosshatch fill — marks the context group

# ── pace thresholds, per window ──────────────────────────────────────────────
# Pace is that window's quota-used minus that window's time-elapsed, so 0 means
# the budget is being spent exactly as fast as the window empties. Green marks
# exactly that and nothing else; every other band is a direction plus a
# severity, and each owns one colour and one glyph.
#
# The four edges below were fitted to 46 days of local transcripts (2026-07-13
# onward, 11.6k assistant messages, 35 five-hour windows, 6 weekly ones) so the
# two-chevron bands fire about 9% of the time and the three-chevron bands about
# 3% — rare enough to mean something. The fit was scored against three separate
# assumptions about where the real quota sits and the worst case minimised, so
# it does not depend on guessing that calibration exactly.
SESSION_FAST=25       # +1 … +25   -> yellow, one chevron
SESSION_FAST_FAR=45   # +25 … +45  -> orange, two;  beyond -> red, three
SESSION_SLOW=35       # -1 … -35   -> sky,    one chevron
SESSION_SLOW_FAR=45   # -35 … -45  -> corn,   two;  beyond -> indigo, three

# The weekly window rests on only 6 samples, so treat these as indicative. Its
# bands are far wider because a 7-day window swings harder than a 5-hour one,
# and because it rarely binds — 1 of 6 weeks finished above 80% used.
WEEK_FAST=80
WEEK_FAST_FAR=90
WEEK_SLOW=70
WEEK_SLOW_FAR=80

# pace_render <pace> -- reads the band edges from PF/PFF/PS/PSF, which the
# caller sets from that window's constants.
# -> $PACE_P (plain, 2 chars) and $PACE_C (glyph + value)
pace_render() {
  PACE_P=""; PACE_C=""
  [ -z "$1" ] && return
  local abs=$1 col ic
  [ "$abs" -lt 0 ] && abs=$(( -abs ))
  [ "$abs" -gt 99 ] && abs=99
  printf -v PACE_P '%02d' "$abs"
  # Seven bands, seven colours, one glyph each — no colour spans two bands and
  # no glyph appears in two colours. Green is dead-on zero and nothing else.
  if   [ "$1" -eq 0 ];       then col=$GREEN;   ic=$PACE_TARGET
  elif [ "$1" -gt "$PFF" ];  then col=$RED;     ic=$PACE_UP_3
  elif [ "$1" -gt "$PF" ];   then col=$ORANGE;  ic=$PACE_UP_2
  elif [ "$1" -gt 0 ];       then col=$YELLOW;  ic=$PACE_UP_1
  elif [ "$1" -ge "-$PS" ];  then col=$SKY;     ic=$PACE_DN_1
  elif [ "$1" -ge "-$PSF" ]; then col=$CORN;    ic=$PACE_DN_2
  else                            col=$INDIGO;  ic=$PACE_DN_3
  fi
  PACE_C="${col}${ic}${PACE_P}${RESET}"
}

# Groups are measured as plain ASCII (exact under any locale); the single-column
# glyphs each group carries are added on top, in GLYPHS.
GLYPHS=0

# ── context group: C 34% ▦1M ──
# The icon binds to the window size, so if the size goes the icon goes with it.
ctx_p=""; ctx_c=""
if [ -n "$ctx_pct" ]; then
  grade "$ctx_pct" 35 40 50
  printf -v n '%02d%%' "$ctx_pct"
  ctx_p="C $n${size:+ $size}"
  ctx_c="${DIM}C${RESET} ${COL}${n}${RESET}${size:+ ${DIM}${CTX_ICON}${RESET}${GREY}${size}${RESET}}"
  [ -n "$size" ] && GLYPHS=$(( GLYPHS + 1 ))
fi

# ── limit groups: S 07%󰅀09 ↺04:13 ──
# label, then the window's usage percentage, the chevron and its pace
# value, and the reset countdown last.
# build_limit <var-prefix> <label> <pct> <cd> <pace> <yellow> <orange> <red>
# Band edges for the pace come from PF/PFF/PS/PSF, set by the caller.
build_limit() {
  local pfx=$1 label=$2 pct=$3 cd=$4 pc=$5 plain="" col_s=""
  printf -v "${pfx}_p" '%s' ""
  printf -v "${pfx}_c" '%s' ""
  [ -z "$pct" ] && return
  pace_render "$pc"
  grade "$pct" "$6" "$7" "$8"
  printf -v n '%02d%%' "$pct"
  plain="${label} $n${PACE_P}${cd:+ $cd}"
  col_s="${DIM}${label}${RESET} ${COL}${n}${RESET}${PACE_C}${cd:+ ${RST}${GREY}${cd}${RESET}}"
  printf -v "${pfx}_p" '%s' "$plain"
  printf -v "${pfx}_c" '%s' "$col_s"
  [ -n "$cd" ]      && GLYPHS=$(( GLYPHS + 1 ))   # the reset marker
  [ -n "$PACE_P" ]  && GLYPHS=$(( GLYPHS + 1 ))   # the chevron
}

rebuild() {
  GLYPHS=0
  [ -n "$ctx_p" ] && [ -n "$size" ] && GLYPHS=$(( GLYPHS + 1 ))
  PF=$SESSION_FAST; PFF=$SESSION_FAST_FAR
  PS=$SESSION_SLOW; PSF=$SESSION_SLOW_FAR
  build_limit five S "$five_pct" "$five_cd" "$pace5" 50 70 90
  PF=$WEEK_FAST; PFF=$WEEK_FAST_FAR
  PS=$WEEK_SLOW; PSF=$WEEK_SLOW_FAR
  build_limit week W "$week_pct" "$week_cd" "$paceW" 70 80 90
}
rebuild

r2_width() {
  R2W=$GLYPHS
  [ -n "$ctx_p" ]  && R2W=$(( R2W + ${#ctx_p} ))
  [ -n "$five_p" ] && { [ "$R2W" -gt "$GLYPHS" ] && R2W=$(( R2W + 3 )); R2W=$(( R2W + ${#five_p} )); }
  [ -n "$week_p" ] && { [ "$R2W" -gt "$GLYPHS" ] && R2W=$(( R2W + 3 )); R2W=$(( R2W + ${#week_p} )); }
}

# Degrade least-informative first: the window size is static for the session,
# then the weekly countdown, then the weekly pace, then the 5-hour pace, then
# the weekly window entirely, and finally the 5-hour countdown. Context usage
# and the 5-hour percentage always stay.
r2_width
[ "$R2W" -gt "$budget" ] && [ -n "$size" ] && {
  size=""
  grade "$ctx_pct" 35 40 50
  printf -v n '%02d%%' "$ctx_pct"
  ctx_p="C $n"; ctx_c="${DIM}C${RESET} ${COL}${n}${RESET}"
  rebuild; r2_width
}
[ "$R2W" -gt "$budget" ] && [ -n "$week_cd" ] && { week_cd=""; rebuild; r2_width; }
[ "$R2W" -gt "$budget" ] && [ -n "$paceW" ]  && { paceW="";   rebuild; r2_width; }
[ "$R2W" -gt "$budget" ] && [ -n "$pace5" ]  && { pace5="";   rebuild; r2_width; }
# Clear week_pct, not just the rendered strings — rebuild() regenerates the
# group from it, so dropping only the output would resurrect it on the next pass.
[ "$R2W" -gt "$budget" ] && [ -n "$week_pct" ] && { week_pct=""; rebuild; r2_width; }
# Last resort, below roughly 21 columns: the 5-hour countdown. Without this the
# row overruns and Claude Code truncates it instead.
[ "$R2W" -gt "$budget" ] && [ -n "$five_cd" ] && { five_cd=""; rebuild; r2_width; }

row2=""
for part in "$ctx_c" "$five_c" "$week_c"; do
  [ -z "$part" ] && continue
  if [ -z "$row2" ]; then row2="$part"; else row2="${row2}${DOT}${part}"; fi
done

# ── emit ─────────────────────────────────────────────────────────────────────
if [ -n "$row1" ] && [ -n "$row2" ]; then
  printf '%b\n%b' "$row1" "$row2"
else
  printf '%b' "${row1}${row2}"
fi
