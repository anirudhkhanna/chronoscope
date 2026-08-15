# ⏱️ Chronoscope

*Webpage Latency Testing Kit*

A synthetic TTFB monitor that drives real, locally installed Chrome to repeatedly hit a set of URLs and measure exactly what a browser sees — the same numbers your Core Web Vitals field data (CrUX) uses — so you can tell whether a latency gap between your app logs and your CWV dashboard is a network/edge problem or an origin problem.

It optionally compares that TTFB against a `Server-Timing` header your app or CDN adds (e.g. `Server-Timing: origin-rtt;dur=495`), so every hit tells you both "what the browser measured" and "what your origin says it took" side by side.

<table>
  <tr>
    <td><img src="https://github.com/user-attachments/assets/57460100-f9f9-4bfc-a98c-fb357b561542" alt="Screenshot Test" width="100%" /></td>
    <td><img src="https://github.com/user-attachments/assets/8435d45c-237b-4cf1-b799-77c07f2d3d2c" alt="Screenshot Results" width="100%" /></td>
  </tr>
</table>

## Why real Chrome, not a simple HTTP client

A plain `curl`/`fetch` request doesn't reproduce the actual TLS/HTTP2 fingerprint, connection behavior, or bot-detection surface a genuine visitor's Chrome presents to your edge (Akamai, Cloudflare, etc.) — which matters if you suspect the discrepancy is coming from *how* the request is made, not just where the server is. This tool drives your actual installed Chrome (not Playwright's bundled Chromium) via CDP, so TTFB, DNS, connect, and TLS timings are as close as a machine can get to "what a real user's browser saw."

## Quick start

```bash
# 1. install
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install

# 2. point it at your site — copy the example and edit it
cp latency-config.example.json latency-config.json

# 3. run (Ctrl+C to stop — it writes a final summary from whatever completed)
node chronoscope.mjs
```

Full CLI and config reference:

```bash
node chronoscope.mjs --help
```

## Config file

Everything site-specific lives in a JSON config (default `./latency-config.json`, or point elsewhere with `--config=<path>`) — nothing in `chronoscope.mjs` should need editing to test a different site.

```json
{
  "name": "Acme",
  "locale": "en-GB",
  "timezoneId": "Europe/London",
  "uaSuffix": "AcmeLatencyBot/1.0",
  "serverTimingMetric": "origin-rtt",
  "headers": { "X-Internal-Test": "1" },
  "testUrls": {
    "home": "https://acme.example/",
    "pdp": {
      "widget-a": "https://acme.example/product/widget-a",
      "widget-b": "https://acme.example/product/widget-b"
    },
    "search": ["https://acme.example/search?q=foo", "https://acme.example/search?q=bar"]
  }
}
```

- **`testUrls`** (required) — each key becomes a "group" you can filter on with `--only`. A group's value can be a single URL, an array of URLs, or a `{name: url}` map — pick whichever fits.
- **`serverTimingMetric`** (optional) — the name of a `Server-Timing` entry your app/CDN adds (e.g. via nginx `add_header Server-Timing 'origin-rtt;dur=...'`). Omit it entirely if you don't have one yet — the tool still measures TTFB, it just skips the gap/alarm comparison.
- **`headers`** (optional) — an object of header-name → string value, sent with every request from the browser context, including the doc call. Useful for a WAF bypass token or an internal-traffic marker header.
- **`name` / `locale` / `timezoneId` / `uaSuffix` / `queryParam` / `alarmGapMs` / `alarmGapRatio`** — all optional, all documented with defaults in `--help`.

## What you get per run

The console output is grouped so a real fact about a specific hit, a derived breakdown, and a computed running average are never mistaken for one another:

```
┌─ Chronoscope run configuration ─────────────────────────────────────────────
│ Site        Acme  (config: latency-config.json)
│ Targets     home, pdp-widget-a, pdp-widget-b, search-foo, search-bar
│ Interval    10s ± 2s jitter
│ Alarm       gap ≥ 500ms OR ratio ≥ 2.5x  (metric: origin-rtt)
│ ...
└─────────────────────────────────────────────────────────────────────────────
[2026-08-13T18:59:21.909Z] home status=200 id=msrvttpx-4222cf proto=h2 "..."
   ttfb :: 420ms  origin-rtt :: 269ms | gap :: 151ms (1.56x)
   ↳ dns=8ms connect=27ms tls=19ms wait=385ms download=179ms
   Σ n=5 (errors=0, alarms=1)  ttfb avg=526ms p75=581ms  origin-rtt avg=334ms p75=485ms  gap avg=192ms p75=253ms
```

Alarming hits print an `!! ALARM (reason) !!` tag and turn the metrics/breakdown lines bold red (the headline never changes color — it's not the fact of the hit that's alarming). The running `Σ` line is dimmed throughout except the metric names, so it always reads as background, never as a fact about the hit above it.

Three files in `logs/`, all sharing one run id:

| File | What's in it |
|---|---|
| `requests-<id>.csv` | One row per hit — TTFB, the configured server-timing value, the gap and why it alarmed (`alarm_reason`: `gap`, `ratio`, or `gap+ratio`), which network/device profile was active, and the DNS/connect/TLS/wait/download breakdown. Good for a spreadsheet pivot. |
| `requests-<id>.jsonl` | Same data plus full detail (every `Server-Timing` entry the response returned), one JSON object per line. |
| `summary-<id>.json` | A tabular overall + per-target breakdown (avg/p75 for TTFB, the configured server-timing metric, and the gap), plus **every alarming hit** from the run — padded with the next-worst non-alarming hits if there were fewer than 5 alarms, so there's always something to compare against. Written once when you stop the run. |

Every hit also carries a unique id as a query param on the actual URL requested (`?latencytest=<id>` by default), so you can cross-reference a specific hit in your own origin/CDN access logs.

## Simulating network and device conditions

```bash
# emulate a slow 4G mobile connection (same CDP call Chrome DevTools' Network tab uses)
node chronoscope.mjs --network=slow-4g          # also: fast-4g, slow-3g
node chronoscope.mjs --network-rtt=250 --network-down=800 --network-up=400   # custom

# emulate a real Android device's viewport/touch/pixel-ratio (same mechanism as DevTools' device toolbar)
node chronoscope.mjs --mobile                    # default: Pixel 7
node chronoscope.mjs --device=galaxy             # also: tablet (Galaxy Tab S8)

# a realistic mobile field visitor: device + typical mobile network together
node chronoscope.mjs --mobile --network=slow-4g
```

CrUX field data skews mobile-heavy on non-fast connections, so this combination is often your best proxy for what real users actually experience, as opposed to your desktop/office-network baseline.

```bash
# document-level timing only — disables JS on the page. TTFB/DNS/connect/
# TLS/download all come from the document response itself, so this strips
# out JS-driven noise (client-side redirects, rendering, third-party tags)
node chronoscope.mjs --no-js
```

## Isolating connection-setup cost from origin response time

Every hit normally opens a brand-new browser context on purpose (see "Why real Chrome" above) — but that means DNS, TCP, and anything sitting between you and the origin (a VPN tunnel, a corporate proxy) get paid fresh on *every single hit*. If that one-time setup cost is large, it looks identical in the numbers to the origin itself being slow — and a manual hard-reload in your browser won't reproduce it, because that reload silently reuses an already-warm connection.

`--reuse-connection` keeps one page open per target for the whole run and reloads it (a fresh unique id each time, logged exactly like any other hit) instead of opening a new context per hit — so only the very first hit on that page pays full connection setup, the same way a real browser tab would behave on a second, third, fourth reload. With multiple targets, each one gets its own dedicated page, so rotating between them never makes one target's connection jump to another's origin — a hit to target A ten seconds after the last one, with target B and C interleaved in between, still reuses A's own warm connection.

```bash
# reuse a persistent connection per target — works with one target or many
node chronoscope.mjs --only=home --reuse-connection
node chronoscope.mjs --only=home,pdp --reuse-connection

# combine with --pause-on-alarm/--manual/--devtools to inspect in the browser
# between hits — the page never closes, so instead of closing a window to
# continue, press Enter in this terminal
node chronoscope.mjs --only=home --reuse-connection --pause-on-alarm --devtools
```

It also applies Empty-Cache-and-Hard-Reload semantics (the same CDP calls as DevTools' own hard-reload button) to every navigation, so the *only* thing ever reused across hits is the TCP connection itself — never a cached response.

If you'd rather not babysit the terminal, `--new-tab-on-alarm` runs unattended instead of pausing: on an alarming hit it leaves that tab exactly as it is (its DevTools Network panel, if `--devtools` is active, still holds just that one request) and opens a fresh tab in the same context — sharing the same reused connection — to keep testing from. Come back later to a row of tabs, one per alarm, each ready to inspect.

```bash
# run unattended and collect one tab per alarm for later inspection
node chronoscope.mjs --only=home --reuse-connection --new-tab-on-alarm --devtools
```

There's no cap on how many tabs accumulate — each is real Chrome memory, so keep an eye on it over a long run.

When you're ready to actually dig into a tab, the first Ctrl+C pauses the run instead of exiting — Chrome and every kept-open tab are left exactly as they are, with no new tabs popping up mid-inspection. Press Enter in the terminal to resume, or Ctrl+C again while paused to stop for good and write the final summary.

## Debugging a specific hit yourself

By default the tool runs fully headless — no window ever appears, so it can't steal focus or interrupt whatever else you're doing. When you actually want to look at what happened:

```bash
# watch it run in a real (off-screen) window, without stopping between hits
node chronoscope.mjs --headed

# after each hit, leave the window open and on-screen until you close it yourself —
# DevTools, the Network tab, whatever you need. No timed interval in this mode;
# your own inspection is the gap.
node chronoscope.mjs --manual

# same, but also auto-opens DevTools for you
node chronoscope.mjs --devtools

# only pause for inspection on hits that actually trip an alarm — everything
# else closes and proceeds automatically, like a normal run
node chronoscope.mjs --pause-on-alarm --devtools
```

One thing worth knowing: DevTools attaches asynchronously, so the very first document request can be missed by the Network panel if you reload too fast right when the window opens — the tool already waits for DevTools to attach before its own navigation fires, but if you want to inspect a *specific* reload yourself, just hit Cmd+R (or Ctrl+R) once the window is open; by then DevTools is definitely attached.

All three of `--manual`/`--devtools`/`--pause-on-alarm` also combine with `--reuse-connection` (see above) — the page just never closes between hits there, so resuming is a keypress in the terminal instead of closing the window.

## Flag reference: what depends on what

There are enough flags now, with enough of them implying or requiring each other, that it's worth laying out the full dependency picture in one place rather than piecing it together across sections above.

**Independent — combine freely, nothing implies or requires anything else:**

- `--config`, `--only`
- `--interval`, `--jitter`
- `--alarm-gap`, `--alarm-ratio`
- `--network=<profile>` — or `--network-rtt`+`--network-down`+`--network-up` together, which override it
- `--no-js`
- `--mobile` — or `--device=<name>`, which implies `--mobile`

**Visibility chain — each one implies everything before it:**

```
--headed  →  --manual  →  --devtools
                       →  --pause-on-alarm
```

- `--headed` shows a real, visible window (pushed off-screen so it stays out of your way). Nothing pauses; it just runs on the normal timed interval where you can watch it.
- `--manual` implies `--headed`. Pauses after *every* hit until you close that window (or quit Chrome) — no timed interval, since your own inspection is the gap.
- `--devtools` implies `--manual`. Same pause-every-hit behavior, plus DevTools is already open on that window.
- `--pause-on-alarm` implies `--manual` too, but narrows *when* it pauses to only hits that actually trip an alarm — everything else proceeds automatically on the normal interval. Composes with `--devtools` (pause only on alarms, but see the Network tab when it happens).

**`--reuse-connection` and what builds on top of it:**

- Works with any number of targets — each one gets its own dedicated persistent page, so they never interfere with each other's connection warmth.
- Combines with any flag in the visibility chain above, but changes *how* pausing works: instead of waiting for you to close the window, it waits for a keypress (Enter) on the same page, since the page is never supposed to close — that's the whole point of reusing its connection.
- `--new-tab-on-alarm` requires `--reuse-connection`. It forces a visible window like `--manual` does, but — unlike everything in the visibility chain — doesn't pause by default. This is also the one exception to that chain: under `--new-tab-on-alarm`, `--devtools` no longer implies pausing either. It still opens DevTools on every tab (including the fresh ones opened after each alarm); it just doesn't force you to be present for it, since the whole point is to collect evidence unattended. A first Ctrl+C pauses the entire run instead of exiting — Chrome and every kept-open tab are left untouched — so you can actually sit and inspect a tab without new ones appearing mid-look; a second Ctrl+C while already paused stops for good.

## Useful flag combinations

```bash
# only the PDP targets, back-to-back with no delay
node chronoscope.mjs --only=pdp --interval=0

# tune alarm sensitivity for this run only
node chronoscope.mjs --alarm-gap=800 --alarm-ratio=3
```

See `CLAUDE.md` for how the codebase is put together internally.

## Author

[Anirudh Khanna](https://github.com/anirudhkhanna)

## License

[MIT](LICENSE)
