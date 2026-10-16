# usage-band

A Claude Code mod: a band above the prompt with live context fill and 5-hour / 7-day usage limits
(bar, %, time to reset), coloured green / yellow / red, plus a toast at 80% and 90% once per window.

- `/usage-band` toggles the band; `/usage-band status` prints the meters as text (works on any window).
- Figures come from Claude Code itself (`$.session.usage()` / `session.measure`), the same ones the status line gets.
  Rate limits show for Pro/Max after the first reply of a session.

## Install

From GitHub (after pushing this folder as a repo):

    /plugin install usage-band --marketplace Achiratch/usage-band

From a local folder, for one session:

    claude --plugin-dir /path/to/usage-band
