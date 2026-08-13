# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

⏱️ Chronoscope — webpage latency testing kit. It drives a real, locally installed Chrome via Playwright to repeatedly hit a configured set of URLs, reads timing straight from the Navigation Timing API (the same numbers CWV/CrUX field data uses), and optionally diffs TTFB against a `Server-Timing` header your origin/CDN adds — to answer "is the gap between what my app reports and what the browser sees a network/edge problem or an origin problem?"

Single file, no framework, no build step: `chronoscope.mjs`. Everything else in the repo is config or output.

## Commands

```bash
# install (skip Playwright's bundled browser download — this tool only ever
# drives real installed Chrome via `channel: 'chrome'`, never bundled Chromium)
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install

# run against ./latency-config.json (default path)
node chronoscope.mjs

# full CLI + config file reference
node chronoscope.mjs --help

# quick syntax check (there is no test suite or linter in this repo — this is
# the only automated correctness check available)
node --check chronoscope.mjs
```

There are no unit tests and no lint config. Correctness has been verified throughout development by running the script live against the real configured site for a short burst (`--interval` set low, `--jitter=0`), sending it `SIGINT`, and inspecting the console output plus the generated `logs/requests-*.csv` / `summary-*.json`. When changing anything in the request lifecycle (`hitOnce`), the network/device emulation, or the shutdown path, that's the way to confirm it still works — there's no other safety net.

`npm start` also works but forwards no args by default; pass flags after `--` (`npm start -- --only=home`), or just call `node chronoscope.mjs` directly.

## Architecture

### Config-driven, not code-driven
All site-specific identity — which URLs to hit, locale/timezone, the UA suffix, the name of the `Server-Timing` metric to compare against — lives in a JSON config file (default `./latency-config.json`, override with `--config=<path>`), not in the script. Adding a new site/brand should never require editing `chronoscope.mjs`; see `latency-config.example.json` for the schema (also documented in full in the `HELP_TEXT` constant at the top of the file).

### Bootstrap order matters
`--help` is checked against raw `argv` and can print and exit **before** any config file is loaded — this is deliberate, so `--help` works even with no config present yet (first-run UX). Only after that does the file resolve a config path, load+validate it (`loadSiteConfig`), and flatten `testUrls` into a target list (`flattenTestUrls`). Reordering these steps risks making `--help` depend on a config file existing.

### Two separate settings namespaces
- `TOOL_DEFAULTS` — how a *run* behaves (interval, jitter, headless/off-screen window, viewport, navigation timeout). CLI-flag-driven, identical regardless of which site you're testing.
- `SITE` — what site this run targets (locale, timezone, UA suffix, query param, custom `headers`, the `Server-Timing` metric name, alarm thresholds), resolved once at startup from the loaded config file, with `TOOL_DEFAULTS` as fallback for anything the config omits.

CLI flags can override `SITE.alarmGapMs`/`alarmGapRatio` per-run, but not locale/UA/targets/headers — those are config-only, since they're site identity, not run behavior.

### Target model
`testUrls` in config can mix three shapes per group: a single URL string, an array of URLs, or a `{name: url}` object — `flattenTestUrls` normalizes all of them into a flat `{name, group, url}` list, with a collision guard that auto-renames and warns on duplicate target names. `slugFromUrl` derives names for array entries from the URL's path *and* query string (URLs differing only by query, e.g. faceted search pages, would otherwise collide on the same path segment). `--only` filters against whatever groups/names the loaded config actually produced — there is no hardcoded target list anywhere.

### Per-request lifecycle (`hitOnce`)
1. A **fresh browser context per request** (not a fresh browser process) — separate cookie jar/cache/connection partition so each hit approximates a first-time visitor rather than reusing a warm connection. `extraHTTPHeaders: SITE.headers` is attached here too, so a config's custom headers ride along on every request from that context.
2. Optional CDP network throttle (`Network.emulateNetworkConditions`) and/or mobile device emulation (viewport/touch/`isMobile` + a derived Chrome-for-Android UA) applied to that context before navigating. If `--devtools` is active, `waitForDevtoolsAttach` polls raw CDP `Target.getTargets` for the `devtools://` target to exist (plus a short buffer) *before* navigating — DevTools attaches asynchronously, racing an immediate `page.goto()`, and the document request (the one thing worth inspecting) is gone for good if the Network panel wasn't yet recording when it fired.
3. Navigate with `waitUntil: 'domcontentloaded'`, deliberately **not** `'load'` — TTFB/DNS/connect/TLS/download all come from the main document's own Navigation Timing entry, fixed well before `load` fires, but waiting for `load` (all images/CSS/JS) can make an otherwise-instant reading fail with a timeout under throttling, for zero accuracy gain.
4. Read `performance.getEntriesByType('navigation')[0]` for the timing breakdown, and optionally find the configured `Server-Timing` entry to compute `gap_ms`/`gap_ratio` and decide `alarm` + `alarm_reason` (`'gap'`, `'ratio'`, or `'gap+ratio'` — tripped by an absolute-ms threshold OR a ratio threshold; either alone misses real cases, see the comment above `alarmGapMs` in `TOOL_DEFAULTS`).
5. In manual mode (`--manual`/`--devtools`/`--pause-on-alarm`), the `finally` block's decision to auto-close the context or leave it open for the human is made *after* step 4, since `--pause-on-alarm` needs `record.alarm` to decide — see `stayOpen` in `hitOnce`.

### Shutdown correctness (non-obvious, don't "simplify")
Playwright installs its own `SIGINT`/`SIGTERM` handler to kill the spawned Chrome process, which calls `process.exit()` itself shortly after the signal. This races the app's own graceful-shutdown code. The fix in `main()`'s `finalizeAndExit` only works because: (a) our handler is registered *before* `launchBrowser()` so Node calls it first (same-event listeners fire in registration order), and (b) it does the summary build + file writes **synchronously, with no `await`**, before calling `process.exit()` itself. Adding an `await` before that write reintroduces the race and can silently drop the final summary write.

### Visibility modes: headless by default, and why the manual-mode plumbing is non-trivial
Headless (`TOOL_DEFAULTS.headless = true`) is the default specifically so a run never steals window focus or shuffles other windows — macOS activates an app on launch regardless of window position, so the old "off-screen headed window" approach didn't actually solve that. The one thing headless changes that matters: Chrome's own UA string says `HeadlessChrome` even in "new" headless mode, an instant bot-detection tell. Since every real navigation already overrides the UA explicitly via the `userAgent` context option (see `buildTaggedUA`), `launchBrowser()` just strips the `HeadlessChrome/` token from the *probed* UA string before anything uses it — the wire UA stays clean regardless of headless state, so there's no accuracy tradeoff.

`--headed` / `--manual` / `--devtools` / `--pause-on-alarm` all run a real, visible window instead (each implies the ones before it: `--pause-on-alarm` → `--manual` → `--headed`). Several things worth knowing if you touch this code:
- **Window sizing is screen-adaptive, not a fixed guess.** `launchBrowser()` probes `window.screen.availWidth/availHeight` (same probe page used for the UA), then sizes `headedViewport` to fit within it minus a margin reserved for Chrome's own title bar/tab strip/toolbar (measured empirically at ~80px; the margin is 120px for safety, with no fixed upper cap — an earlier version also capped this at a flat 1280x800 "to be safe," which instead made the window look tiny on any screen with a larger logical resolution than that, i.e. most modern laptops).
- **That probe context must pass `viewport: null`.** Without it, Playwright applies its own default device-metrics override (a fixed 1280x720 emulated viewport) to the context, and Chrome's `window.screen.*` properties then report *that emulated size* back as if it were the real display — completely independent of the actual screen, and identical on every run regardless of the real resolution. `viewport: null` disables the override so the probe reflects the real host window.
- **A real off-screen window is not achievable on macOS.** `--headed` (without `--manual`) pushes the window to `--window-position=10000,0` to stay out of your way, but macOS's window manager won't let a standard, focusable app window have zero overlap with any display — it snaps back to keep some minimum portion reachable, so it ends up partially visible regardless of how far off you push it. This is expected, not a bug to keep chasing; `--manual`/`--devtools` never try to hide the window in the first place (you need to see and click on it), so they're unaffected.
- **A dead browser connection during manual pauses is expected, not exceptional.** Real Chrome's shutdown (updater/crash-reporter cleanup subprocesses, etc.) can leave it in a zombie state for several seconds after its last window closes — not usable, but not yet reporting `disconnected` either. `main()`'s loop handles this with a one-shot retry: if a request fails against a browser that's dead (`!browser.isConnected()` or the error message itself says so), it relaunches and redoes that exact request before recording anything, so quitting Chrome mid-manual-session costs zero spurious error rows. `waitForManualClose` resolves on whichever of `page.on('close')` or `browser.on('disconnected')` fires first, with both listeners explicitly cleaned up either way to avoid a slow leak across a long manual session.

`--pause-on-alarm` reuses all of the above but only keeps the context open when `record.alarm` is true — everything else auto-closes and proceeds on the normal timed interval, same as a fully automated run.

### Network throttling and mobile emulation
`--network=<preset>` calls the same CDP method (`Network.emulateNetworkConditions`) Chrome DevTools' own Network tab throttling uses, so it affects the *whole* request lifecycle (connect/TLS/response/download), not a delay tacked onto the end. `NETWORK_PRESETS`' `slow-4g`/`slow-3g` numbers are the long-standing Lighthouse/WebPageTest mobile defaults, not whatever Chrome's own DevTools UI currently ships — those have shifted across Chrome versions.

`--mobile`/`--device=<name>` emulate a real Android device's viewport/touch/pixel-ratio via the same CDP mechanism as DevTools' device toolbar. Android, not iPhone: driving real Chrome under an iPhone UA would claim Safari/WebKit while the engine underneath is still Chromium — a mismatch real bot detection can key on. The UA itself is never hardcoded; `toMobileUA` rewrites the *actually probed* desktop UA into the Chrome-for-Android format, keeping the real `Chrome/<version>` token intact so it can't drift stale relative to whatever Chrome is actually installed.

### Output
Every run writes three files into `logs/`, all sharing one `runId`: `requests-*.csv` (flat per-hit rows — includes `network_profile`, `device_profile`, `alarm`, `alarm_reason` alongside the timing breakdown, for spreadsheet pivoting), `requests-*.jsonl` (one JSON object per line, full detail including the raw `server_timing` array), and `summary-*.json` (aggregate stats + `notableGaps`, written once on shutdown). Each hit's unique id is embedded as a query param (`SITE.queryParam`, default `latencytest`) on the actual URL requested, so a specific hit can be cross-referenced in the origin's own access/app logs.

`notableGaps` (in `buildSummary`) is every alarming hit, not the N largest gaps — alarm is OR-triggered (gap OR ratio), so a ratio-triggered alarm can have a smaller absolute gap than some hit that never alarmed at all; sorting by raw `gap_ms` and taking the top 5 could silently drop a real alarm in favor of a bigger-but-fine one. Below `NOTABLE_GAPS_TARGET` (5) alarms, it pads with the next-worst non-alarming hits so there's still something to compare against; at or above it, every alarm is shown with no cap.

Padding can come up short of `NOTABLE_GAPS_TARGET` for a reason that looks like a bug but isn't: padding only has candidates from `withServerTimingAll` (hits that actually returned the configured `Server-Timing` metric), so a target with no `serverTimingMetric` data (e.g. a third-party comparison URL) contributes zero non-alarming candidates regardless of how many hits it had. `buildSummary` exposes `eligibleNonAlarmingCount` (the size of that candidate pool) specifically so `printFinalSummary` can tell "padded short because there weren't enough alarms" apart from "padded short because there was nothing eligible to pad with" — the latter prints an explicit caveat line under the section title rather than silently showing fewer than 5 entries with no explanation.

### Console output formatting
Three distinct visual registers, used consistently everywhere:
- **Static run config** (`boxTop`/`boxLine`/`boxBottom`) — the startup banner and the final summary's header both use this bordered "info panel" look. Left-bordered only, no fixed right edge: a box that has to align on both sides breaks the moment a value is longer than expected (the User-Agent line is ~140 chars); terminals wrap long lines fine on their own, so there's nothing to gain by fighting that.
- **Live per-hit facts** (`logRequest`) — three lines per hit: an unstyled headline (identity — never bolded/reddened even when alarming, since the *fact of this hit* isn't what's alarming), a metrics line (`ttfb :: value` — bold on the **value** only, not the label, `|` separating the two independently-measured numbers from the derived gap), and a `↳`-prefixed breakdown line (DNS/connect/TLS/wait/download). `buildMetricsLine`/`buildBreakdownLine` are shared between this and the final summary's `notableGaps` list specifically so an entry looks identical whether you're watching it scroll by live or reading it after the fact — don't let these two call sites drift into similar-but-not-quite-matching formats again.
- **Computed/secondary data** (`printRunningAggregate`, the DNS/connect/TLS/wait table in the final summary) — dimmed (`dimize`/`boldDim`), with only the metric *names* bolded (opposite of the per-hit metrics line, which bolds the *value*) so a label still anchors the eye while everything around it reads as background. `fmtMs` deliberately does **not** pad values to a fixed width — an earlier version did, and it made columns look *less* even, not more, since only some values happened to need the extra leading space to reach a given width.

One non-obvious constraint behind all of this: ANSI SGR codes aren't nested/scoped, just a flat stream of state changes. Wrapping an already-`boldize()`d segment inside an outer `alarmize()`/`dimize()` call causes the inner segment's own reset to cancel the outer style for everything after it. The fix used throughout is to never nest styling calls — either build a line from small self-contained segments (each with its own open+reset, safe to concatenate), or decide once per line which single style (if any) wraps the whole already-plain-text line.

For the "Overall + per-target" and "DNS/connect/TLS/wait" tables in the final summary, `renderTable` computes column widths from the *raw* (unstyled) content — same reasoning as `boxTop`'s dash-count math — then applies `headerStyle` per-cell (self-contained) and `rowStyle` to the whole already-plain joined line (safe only because data cells have no ANSI of their own to conflict with it).
