// HELP_TEXT and KNOWN_FLAGS — both pure data (string/Set construction only),
// no side effects on import, so the entry point controls exactly when
// --help is checked and unknown flags are alerted on. See chronoscope.mjs's
// bootstrap sequence for why that ordering matters.
import { TOOL_DEFAULTS, NETWORK_PRESETS, MOBILE_PRESETS, DEFAULT_MOBILE_PRESET, DEFAULT_CONFIG_PATH } from './constants.mjs';

export const HELP_TEXT = `⏱️  Chronoscope — webpage latency testing kit

Usage: node chronoscope.mjs [options]

Config file (JSON), default path: ./${DEFAULT_CONFIG_PATH} — override with --config=<path>.

  Required: "testUrls" — an object whose keys become filterable "groups".
  Each group's value can be:
    - a single URL string       -> one target named after the group
    - an array of URL strings   -> targets named "<group>-<slug-of-url>"
    - an object of {name: url}  -> targets named "<group>-<name>"

  Optional: "name" (site/brand label, shown in banners), "locale" (BCP-47,
  default "${TOOL_DEFAULTS.locale}"), "timezoneId" (IANA, default "${TOOL_DEFAULTS.timezoneId}"),
  "uaSuffix" (appended to the real Chrome UA so hits are identifiable/
  filterable in your own access logs or RUM — defaults to "<Name>-ChronoscopeLatencyBot/1.0"),
  "serverTimingMetric" (name of a Server-Timing entry your app/CDN adds, e.g.
  via nginx \`add_header Server-Timing 'foo;dur=...'\`, compared against TTFB
  to see how much of any gap is edge/network vs. origin — omit to disable
  that comparison entirely), "queryParam" (default "${TOOL_DEFAULTS.queryParam}"),
  "alarmGapMs"/"alarmGapRatio" (defaults for --alarm-gap/--alarm-ratio below),
  "headers" (an object of header-name -> string value, sent with every
  first-party request, including the doc call, but never to third-party
  subresources like fonts/analytics — e.g. a WAF bypass token or an
  internal-traffic marker header).

  Example:
  {
    "name": "Acme",
    "locale": "en-GB",
    "timezoneId": "Europe/London",
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

Options:
  --config=<path>           Path to the config file described above.
  --only=<group|name,...>   Which targets to hit: a group name, a specific
                            target name, "all" (default), or a comma list of
                            any of those — all derived from your config's
                            "testUrls". An invalid value's error message
                            lists exactly what your loaded config offers.
  --interval=<seconds>      Gap after each request completes before firing the
                            next one. Use 0 to fire back-to-back immediately.
                            Default: ${TOOL_DEFAULTS.intervalMs / 1000}s.
  --jitter=<seconds>        Random +/- variance added to --interval so the
                            cadence isn't a perfect metronome. Default: ${TOOL_DEFAULTS.jitterMs / 1000}s.
                            Automatically capped to --interval.
  --alarm-gap=<ms>          Flag a request if TTFB exceeds the configured
                            Server-Timing value by at least this many ms.
                            Default: ${TOOL_DEFAULTS.alarmGapMs} (or the config's "alarmGapMs").
  --alarm-ratio=<multiplier> Flag a request if TTFB is at least this many
                            times the configured Server-Timing value.
                            Default: ${TOOL_DEFAULTS.alarmGapRatio} (or the config's "alarmGapRatio").
  --network=<profile>       Emulate a network condition via Chrome DevTools'
                            throttling (same CDP call the Network tab uses):
                            "${Object.keys(NETWORK_PRESETS).join('", "')}", or "none" (default,
                            uses your real unthrottled connection).
  --network-rtt=<ms>        Custom throttle: added round-trip latency. Must be
                            given together with --network-down/--network-up
                            (overrides --network).
  --network-down=<kbps>     Custom throttle: download cap in kbps.
  --network-up=<kbps>       Custom throttle: upload cap in kbps.
  --no-js                   Disable JavaScript on the page. TTFB/DNS/connect/
                            TLS/download all come from the document response
                            itself and don't depend on scripts running, so
                            this strips out JS-driven noise (client-side
                            redirects, rendering, third-party tags) when
                            you're only after document-level timing.
  --reuse-connection        Keep one persistent page open per target for the
                            whole run and navigate it to a fresh URL (unique
                            id, logged exactly like any other hit) each time,
                            instead of opening a brand-new browser context
                            per hit. With multiple targets, each gets its own
                            dedicated page — rotating between them never
                            makes one target's connection jump to another's
                            origin. Also applies Empty-Cache-and-Hard-Reload
                            semantics (same CDP calls as DevTools' hard-reload
                            button) to every navigation, so nothing but the
                            TCP connection itself is reused. This approximates
                            a hand reload in an already-open tab — Chrome
                            reuses its already-established connection —
                            rather than a first-time visitor who always pays
                            full connection setup. Useful for isolating
                            one-time connection-setup cost (e.g. a VPN's
                            per-connection tax) from a site's actual response
                            time. Combines with --manual/--devtools/--pause-on-alarm
                            — see --manual below for how pausing differs in
                            this mode. Needs an interactive terminal attached
                            to stdin when combined with those (it waits on a
                            keypress). Ctrl+C stops the run — except under
                            --new-tab-on-alarm, where a first Ctrl+C pauses
                            instead; see --new-tab-on-alarm below.
  --mobile                  Emulate a mobile Android/Chrome device instead of
                            desktop (viewport, touch, device pixel ratio, and
                            a Chrome-Mobile User-Agent using your real Chrome's
                            version). Shorthand for --device=${DEFAULT_MOBILE_PRESET}.
  --device=<name>           Specific mobile device profile: "${Object.keys(MOBILE_PRESETS).join('", "')}".
                            Implies --mobile.
  --headed                  Run a real, visible Chrome window (pushed
                            off-screen so it doesn't interrupt you) instead of
                            the headless default. Useful to watch a run or to
                            eyeball a page for a bot-challenge screen.
  --manual                  After each hit, leave the Chrome window open and
                            on-screen (implies --headed) so you can inspect/
                            debug it yourself — DevTools, network tab,
                            whatever you need. The run resumes as soon as you
                            close that window (or quit Chrome entirely); no
                            timed interval is applied between requests in
                            this mode, since your own inspection is the gap.
                            With --reuse-connection, the page is never closed
                            between hits (that's the whole point — a warm
                            connection), so instead it pauses for a keypress
                            (Enter) in this terminal, then resumes reloading
                            the same page/connection.
  --devtools                Auto-open DevTools alongside the page (implies
                            --manual), via Chrome's own
                            --auto-open-devtools-for-tabs. Click the Network
                            tab yourself once it's open — which panel it opens
                            to by default is up to Chrome, not something this
                            tool controls.
  --pause-on-alarm          Only pause for manual inspection (implies
                            --manual) on hits that actually trip an alarm —
                            everything else closes and proceeds automatically
                            on the normal timed interval, like a non-manual
                            run. Combine with --devtools to only get DevTools
                            in your face when something's actually wrong. See
                            --manual above for how "pause" differs when
                            combined with --reuse-connection.
  --new-tab-on-alarm        Requires --reuse-connection. On an alarming hit,
                            leave that tab exactly as it is (its DevTools
                            Network panel, if --devtools is active, keeps
                            just that one request) and open a fresh tab in
                            the same context — sharing the same reused
                            connection — to keep testing from. Unlike
                            --pause-on-alarm, this doesn't pause automatically:
                            run it unattended for a while and come back to a
                            row of tabs, one per alarm, each ready to inspect.
                            No cap on how many tabs accumulate — each one is
                            real Chrome memory, so watch it on a long run.
                            Forces a visible window, same as --manual. A
                            first Ctrl+C pauses the run instead of exiting —
                            Chrome and every kept-open tab are left exactly as
                            they are — so you can actually sit and inspect a
                            tab without new ones appearing mid-look. Press
                            Enter in this terminal to resume, or Ctrl+C again
                            (while already paused) to stop for good.
  --help                    Show this message.
`;

// Every flag this tool recognizes, kept as a flat list here rather than
// derived from HELP_TEXT — parseArgs() itself doesn't validate flag *names*,
// just extracts whatever --key=value pairs are present, so a typo like
// --reuse-connecton would otherwise be silently accepted and simply do
// nothing, with no indication anything was wrong.
export const KNOWN_FLAGS = new Set([
  'config', 'only', 'interval', 'jitter', 'alarm-gap', 'alarm-ratio',
  'network', 'network-rtt', 'network-down', 'network-up', 'no-js',
  'reuse-connection', 'mobile', 'device', 'headed', 'manual', 'devtools',
  'pause-on-alarm', 'new-tab-on-alarm', 'help',
]);
