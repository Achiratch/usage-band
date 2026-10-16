# usage-band

A Claude Code mod: a band above the prompt with live context fill and 5-hour / 7-day usage limits
(bar, %, time to reset), coloured green / yellow / red, plus a toast at 80% and 90% once per window.

It also **pauses work before you hit the limit** and picks it up again after the reset.

## Pause and resume

- When a window reaches the pause threshold (default **95%**), every tool call is denied with a note telling
  Claude to stop and say where it got to. The band shows **⏸ paused** with a Resume button.
- **5-hour window:** a timer waits until the window resets (plus one minute), keeps the Mac from idle-sleeping
  meanwhile (`caffeinate -i`), then sends Claude *"continue the task you were working on"*.
- **7-day or spend window:** the reset can be days away, so it pauses and waits for you instead.
- Once a window has been resumed it never pauses again in that same window.

The Claude app must stay open and the Mac awake (lid open) for the automatic continue to fire.

## Commands

| Command | What it does |
| --- | --- |
| `/usage-band` | Show or hide the band |
| `/usage-band status` | Print the meters, the threshold and any pause as text (works on any window) |
| `/usage-band pause-at <1-100>` | Set the pause threshold, kept across sessions |
| `/usage-band resume` | Lift the pause now and ask Claude to continue |
| `/usage-band cancel` | Lift the pause without sending anything |

Figures come from Claude Code itself (`$.session.usage()` / `session.measure`), the same ones the status line gets.
Rate limits show for Pro/Max after the first reply of a session.

## Install

    /plugin install usage-band --marketplace Achiratch/usage-band

From a local folder, for one session:

    claude --plugin-dir /path/to/usage-band
