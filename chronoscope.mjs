// ⏱️ Chronoscope — webpage latency testing kit, driven by real installed Chrome.
//
// Site-specific detail (which URLs to hit, locale/timezone, the UA suffix,
// and the name of a Server-Timing metric to compare TTFB against) all comes
// from a JSON config file — see HELP_TEXT below for the schema, or run with
// --help. Nothing in this file should need editing to point it at a
// different brand/site; only the config file should change.
//
// Why real Chrome (channel: 'chrome') instead of Playwright's bundled Chromium:
// we want the exact TLS/HTTP2 fingerprint and network stack a genuine visitor's
// Chrome presents to the edge, so results are comparable to field CWV data.
//
// TTFB is read from the Navigation Timing L2 API (`responseStart`), the same
// number the browser reports for the CWV TTFB metric — it transparently
// accounts for redirects, unlike request-level CDP timing. Additional fields
// (DNS/connect/TLS/wait/download) come from the same performance entry, so we
// can see WHERE time is going, not just the total.

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// CDP-level throttling (same mechanism Chrome DevTools' Network tab uses:
// Network.emulateNetworkConditions), so these numbers aren't guaranteed to
// match whatever your installed Chrome's DevTools UI currently ships as
// presets — those have shifted across versions (Chrome has periodically
// retuned them against real CrUX network distributions). Instead these are
// the long-standing Lighthouse/WebPageTest mobile throttling defaults, which
// are the most widely cited, stable reference points for "slow-4g"/"slow-3g".
// Override any of them with --network-rtt/--network-down/--network-up if you
// want exact numbers to match a spec you were given.
const NETWORK_PRESETS = {
  'fast-4g': { rttMs: 40, downloadKbps: 10240, uploadKbps: 5120 }, // decent LTE, approximate
  'slow-4g': { rttMs: 150, downloadKbps: 1638.4, uploadKbps: 768 }, // Lighthouse mobile default
  'slow-3g': { rttMs: 400, downloadKbps: 400, uploadKbps: 400 }, // classic "Regular/Slow 3G"
};

// Real device viewport/touch metrics (same CDP mechanism as Chrome DevTools'
// device toolbar: Emulation.setDeviceMetricsOverride + touch emulation).
// The User-Agent is NOT hardcoded here — it's derived at runtime from your
// real installed Chrome's own version (see buildTaggedUA/toMobileUA), so the
// Chrome/<version> token always matches the actual binary driving the
// request instead of drifting stale like a hardcoded preset string would.
// Android models are used (not iPhone) because we're driving real Chrome —
// an iPhone UA would claim Safari/WebKit while the engine underneath is
// still Chromium, a mismatch real bot detection can key on.
const MOBILE_PRESETS = {
  pixel: { label: 'Pixel 7 (Android phone)', viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, androidVersion: '13', deviceModel: 'Pixel 7' },
  galaxy: { label: 'Galaxy S22 (Android phone)', viewport: { width: 360, height: 780 }, deviceScaleFactor: 3, androidVersion: '13', deviceModel: 'SM-S901B' },
  tablet: { label: 'Galaxy Tab S8 (Android tablet)', viewport: { width: 800, height: 1280 }, deviceScaleFactor: 2, androidVersion: '13', deviceModel: 'SM-X706B' },
};
const DEFAULT_MOBILE_PRESET = 'pixel';

// Tool-level defaults: how a run behaves, not what site it's testing. None of
// these belong in the config file — they're re-chosen per invocation via CLI
// flags, not per brand.
const TOOL_DEFAULTS = {
  intervalMs: 10000, // gap after each request completes before firing the next. Override with --interval=<seconds>.
  jitterMs: 2000, // +/- random jitter so cadence isn't a perfect metronome. Override with --jitter=<seconds>.
  navigationTimeoutMs: 30000,
  // Headless by default so no window ever steals focus/shuffles your other
  // windows (macOS activates an app on launch regardless of window position —
  // off-screen placement alone doesn't stop that). Chrome's headless UA
  // contains "HeadlessChrome", but every real navigation already overrides
  // the UA explicitly (see buildTaggedUA), so launchBrowser() strips that
  // token from the probed string before anything else uses it — the wire UA
  // stays clean either way. Override with --headed if you want to watch it
  // run or eyeball a page for a bot-challenge screen.
  headless: true,
  windowOffscreen: true, // only matters when --headed is used
  logDir: './logs',
  viewport: { width: 1920, height: 1080 }, // desktop default; mobile presets override this
  // Whenever the window is actually visible (--headed/--manual/--devtools),
  // 1920x1080 makes for a window bigger than most screens, so launchBrowser()
  // computes a screen-fitting size instead — see headedViewport there.
  // Fallbacks used only if the config file doesn't specify its own values.
  locale: 'en-US',
  timezoneId: 'UTC',
  queryParam: 'latencytest',
  alarmGapMs: 500,
  alarmGapRatio: 2.5,
};

const DEFAULT_CONFIG_PATH = 'latency-config.json';

const HELP_TEXT = `⏱️  Chronoscope — webpage latency testing kit

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
  request from the browser context, including the doc call — e.g. a WAF
  bypass token or an internal-traffic marker header).

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
  --only=<group|name,...>  Which targets to hit: a group name, a specific
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
                            in your face when something's actually wrong.
  --help                    Show this message.
`;

const rawArgv = process.argv.slice(2);
if (rawArgv.includes('--help')) {
  console.log(HELP_TEXT);
  process.exit(0);
}

function findConfigPath(argv) {
  for (const arg of argv) {
    const m = arg.match(/^--config=(.*)$/);
    if (m) return m[1];
  }
  return DEFAULT_CONFIG_PATH;
}

function loadSiteConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    console.error(
      `Config file not found: ${resolved}\n\n` +
      `Point at one with --config=<path>, or create ${DEFAULT_CONFIG_PATH} in the ` +
      `current directory. Run with --help to see the expected format.`
    );
    process.exit(1);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse config file ${resolved}: ${err.message}`);
    process.exit(1);
  }
  if (!raw.testUrls || typeof raw.testUrls !== 'object' || Array.isArray(raw.testUrls) || Object.keys(raw.testUrls).length === 0) {
    console.error(`Config file ${resolved} must have a non-empty "testUrls" object. Run with --help to see the expected format.`);
    process.exit(1);
  }
  return raw;
}

function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    // Include the query string too — URLs that only differ by query (e.g.
    // faceted search/filter pages sharing one path) would otherwise all
    // slug to the same last path segment and collide.
    const base = (segments[segments.length - 1] || '') + (u.search ? `-${u.search.slice(1)}` : '');
    return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
  } catch {
    return '';
  }
}

// testUrls[group] can be a single URL string, an array of URLs, or an object
// mapping a short name to each URL — whichever shape fits that group best.
function flattenTestUrls(testUrls) {
  const targets = [];
  const seenNames = new Set();

  function addTarget(name, group, url) {
    let finalName = name;
    let suffix = 2;
    while (seenNames.has(finalName)) {
      finalName = `${name}-${suffix}`;
      suffix += 1;
    }
    if (finalName !== name) {
      console.error(`Warning: target name "${name}" collided; renamed to "${finalName}". Give it an explicit name in the config to avoid this.`);
    }
    seenNames.add(finalName);
    targets.push({ name: finalName, group, url });
  }

  for (const [groupName, value] of Object.entries(testUrls)) {
    if (typeof value === 'string') {
      addTarget(groupName, groupName, value);
    } else if (Array.isArray(value)) {
      value.forEach((url, i) => {
        const slug = slugFromUrl(url) || String(i + 1);
        addTarget(`${groupName}-${slug}`, groupName, url);
      });
    } else if (value && typeof value === 'object') {
      for (const [subName, url] of Object.entries(value)) {
        addTarget(`${groupName}-${subName}`, groupName, url);
      }
    } else {
      console.error(`Invalid "testUrls.${groupName}": expected a URL string, an array of URLs, or an object of name -> URL.`);
      process.exit(1);
    }
  }
  return targets;
}

function describeTargets(targets) {
  const groups = [...new Set(targets.map((t) => t.group))];
  return `Groups: ${groups.join(', ')}\nTargets: ${targets.map((t) => t.name).join(', ')}`;
}

const configPath = findConfigPath(rawArgv);
const siteConfigRaw = loadSiteConfig(configPath);
const ALL_TARGETS = flattenTestUrls(siteConfigRaw.testUrls);

function validateHeaders(raw) {
  if (raw.headers === undefined) return {};
  const isPlainObject = raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers);
  const allStrings = isPlainObject && Object.values(raw.headers).every((v) => typeof v === 'string');
  if (!isPlainObject || !allStrings) {
    console.error(`Config "headers" must be an object of header-name -> string value, e.g. {"X-Test": "1"}.`);
    process.exit(1);
  }
  return raw.headers;
}

const SITE = {
  name: siteConfigRaw.name || 'site',
  configPath,
  serverTimingMetric: siteConfigRaw.serverTimingMetric || null,
  locale: siteConfigRaw.locale || TOOL_DEFAULTS.locale,
  timezoneId: siteConfigRaw.timezoneId || TOOL_DEFAULTS.timezoneId,
  queryParam: siteConfigRaw.queryParam || TOOL_DEFAULTS.queryParam,
  uaSuffix:
    siteConfigRaw.uaSuffix ||
    (siteConfigRaw.name
      ? `${siteConfigRaw.name.replace(/[^a-zA-Z0-9]/g, '')}-ChronoscopeLatencyBot/1.0`
      : 'ChronoscopeLatencyBot/1.0'),
  headers: validateHeaders(siteConfigRaw),
  alarmGapMs: typeof siteConfigRaw.alarmGapMs === 'number' ? siteConfigRaw.alarmGapMs : TOOL_DEFAULTS.alarmGapMs,
  alarmGapRatio: typeof siteConfigRaw.alarmGapRatio === 'number' ? siteConfigRaw.alarmGapRatio : TOOL_DEFAULTS.alarmGapRatio,
};

// The actual configured metric name (e.g. "prism-server-rtt") reads better in
// logs/CSV than a generic "app-server" label — falls back to a generic label
// only when no serverTimingMetric is configured at all.
const METRIC_LABEL = SITE.serverTimingMetric || 'server-timing';

// The final summary's "notable gaps" list shows every alarm, padded up to
// this many total with the next-worst non-alarming hits if there were fewer
// alarms than this.
const NOTABLE_GAPS_TARGET = 5;

const ANSI = { red: '\x1b[31m', bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m' };
function alarmize(str) {
  return `${ANSI.bold}${ANSI.red}${str}${ANSI.reset}`;
}
function boldize(str) {
  return `${ANSI.bold}${str}${ANSI.reset}`;
}
function dimize(str) {
  return `${ANSI.dim}${str}${ANSI.reset}`;
}
function boldDim(str) {
  return `${ANSI.bold}${ANSI.dim}${str}${ANSI.reset}`;
}

function fmtMs(v) {
  return v === null || v === undefined ? 'n/a' : `${v}ms`;
}

// Shared by the live per-request log and the final summary's "Top 5 gaps" —
// same underlying facts (ttfb/server/gap, or the DNS/connect/TLS/wait/
// download breakdown), so both should look identical rather than drifting
// into two similar-but-not-quite-matching formats. `alarm` decides styling:
// bold values only when not alarming (alarm lines get uniformly bold+red by
// the caller, which would conflict with inner styling — ANSI resets aren't
// nested/scoped, see the note in logRequest).
function buildMetricsLine(rec) {
  const ttfbVal = fmtMs(rec.ttfb_ms);
  const serverVal = rec.server_ms === null ? (SITE.serverTimingMetric ? 'MISSING' : 'n/a') : fmtMs(rec.server_ms);
  const gapVal = rec.gap_ms === null ? 'n/a' : fmtMs(rec.gap_ms);
  const gapRatioSuffix = rec.gap_ms === null ? '' : ` (${rec.gap_ratio}x)`;
  return rec.alarm
    ? `   ttfb :: ${ttfbVal}  ${METRIC_LABEL} :: ${serverVal} | gap :: ${gapVal}${gapRatioSuffix}`
    : `   ttfb :: ${boldize(ttfbVal)}  ${METRIC_LABEL} :: ${boldize(serverVal)} | gap :: ${boldize(gapVal)}${gapRatioSuffix}`;
}
function buildBreakdownLine(rec) {
  return `   ↳ dns=${fmtMs(rec.dns_ms)} connect=${fmtMs(rec.connect_ms)} tls=${fmtMs(rec.tls_ms)} ` +
    `wait=${fmtMs(rec.wait_ms)} download=${fmtMs(rec.download_ms)}`;
}

// A small bordered "info panel" for the startup banner — visually separates
// one-time run configuration from the scrolling per-request log lines below
// it. Left-bordered only (no fixed right edge): a fixed-width box that must
// align on both sides breaks the moment a value is longer than expected
// (e.g. a full User-Agent string) — terminals wrap long lines fine on their
// own, so there's nothing to gain by fighting that.
const BOX_WIDTH = 78;
function boxTop(title) {
  const dashes = '─'.repeat(Math.max(2, BOX_WIDTH - title.length - 4));
  console.log(`┌─ ${boldize(title)} ${dashes}`);
}
function boxLine(label, value) {
  console.log(`│ ${label.padEnd(11)} ${value}`);
}
function boxBottom() {
  console.log(`└${'─'.repeat(BOX_WIDTH - 1)}`);
}

// A minimal table renderer for the final summary: bold header row, a dashed
// rule under it, then rows padded to each column's own max content width
// (computed from the raw, unstyled text — same reasoning as boxTop's dash
// count — so styling never throws off alignment). `aligns` is 'l' or 'r' per
// column; numeric columns should be right-aligned so digits line up for
// magnitude comparison, text columns left-aligned to read as words.
function renderTable(headers, rows, aligns, { headerStyle = boldize, rowStyle = (s) => s } = {}) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const pad = (s, w, align) => (align === 'r' ? String(s).padStart(w) : String(s).padEnd(w));
  // headerStyle wraps each cell individually (self-contained, safe to join
  // plainly); rowStyle wraps the whole already-joined line for the rule and
  // data rows, which is only safe because those cells are plain, un-styled
  // text with no ANSI codes of their own to conflict with it.
  console.log(headers.map((h, i) => headerStyle(pad(h, widths[i], aligns[i]))).join('  '));
  console.log(rowStyle(widths.map((w) => '─'.repeat(w)).join('  ')));
  for (const row of rows) {
    console.log(rowStyle(row.map((c, i) => pad(c, widths[i], aligns[i])).join('  ')));
  }
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

function resolveRuntimeConfig(argv) {
  const cli = parseArgs(argv);

  let targets = ALL_TARGETS;
  if (cli.only) {
    const wanted = String(cli.only).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!wanted.includes('all')) {
      targets = ALL_TARGETS.filter((t) => wanted.includes(t.group) || wanted.includes(t.name));
      if (targets.length === 0) {
        console.error(`--only=${cli.only} matched no targets.\n\n${describeTargets(ALL_TARGETS)}`);
        process.exit(1);
      }
    }
  }

  let intervalMs = TOOL_DEFAULTS.intervalMs;
  if (cli.interval !== undefined) {
    const seconds = Number(cli.interval);
    if (Number.isNaN(seconds) || seconds < 0) {
      console.error(`--interval must be a non-negative number of seconds, got "${cli.interval}"`);
      process.exit(1);
    }
    intervalMs = seconds * 1000;
  }

  let jitterMs = TOOL_DEFAULTS.jitterMs;
  if (cli.jitter !== undefined) {
    const seconds = Number(cli.jitter);
    if (Number.isNaN(seconds) || seconds < 0) {
      console.error(`--jitter must be a non-negative number of seconds, got "${cli.jitter}"`);
      process.exit(1);
    }
    jitterMs = seconds * 1000;
  }
  jitterMs = Math.min(jitterMs, intervalMs); // never let jitter push below a 0 floor beyond what --interval already implies

  let alarmGapMs = SITE.alarmGapMs;
  if (cli['alarm-gap'] !== undefined) {
    const ms = Number(cli['alarm-gap']);
    if (Number.isNaN(ms) || ms < 0) {
      console.error(`--alarm-gap must be a non-negative number of ms, got "${cli['alarm-gap']}"`);
      process.exit(1);
    }
    alarmGapMs = ms;
  }

  let alarmGapRatio = SITE.alarmGapRatio;
  if (cli['alarm-ratio'] !== undefined) {
    const ratio = Number(cli['alarm-ratio']);
    if (Number.isNaN(ratio) || ratio <= 0) {
      console.error(`--alarm-ratio must be a positive number, got "${cli['alarm-ratio']}"`);
      process.exit(1);
    }
    alarmGapRatio = ratio;
  }

  let networkProfileName = 'none';
  let networkProfile = null;
  const hasCustomNetworkFlag = cli['network-rtt'] !== undefined || cli['network-down'] !== undefined || cli['network-up'] !== undefined;

  if (hasCustomNetworkFlag) {
    const allGiven = cli['network-rtt'] !== undefined && cli['network-down'] !== undefined && cli['network-up'] !== undefined;
    const rttMs = Number(cli['network-rtt']);
    const downloadKbps = Number(cli['network-down']);
    const uploadKbps = Number(cli['network-up']);
    const allValid = [rttMs, downloadKbps, uploadKbps].every((n) => !Number.isNaN(n) && n >= 0);
    if (!allGiven || !allValid) {
      console.error('--network-rtt, --network-down, and --network-up must all be given together as non-negative numbers.');
      process.exit(1);
    }
    networkProfileName = 'custom';
    networkProfile = { rttMs, downloadKbps, uploadKbps };
  } else if (cli.network !== undefined && cli.network !== 'none') {
    const preset = NETWORK_PRESETS[cli.network];
    if (!preset) {
      console.error(`--network=${cli.network} is not a known preset. Valid: none, ${Object.keys(NETWORK_PRESETS).join(', ')}, or use --network-rtt/--network-down/--network-up for a custom profile.`);
      process.exit(1);
    }
    networkProfileName = cli.network;
    networkProfile = preset;
  }

  let deviceProfileName = 'desktop';
  let deviceProfile = null;
  if (cli.device !== undefined) {
    const preset = MOBILE_PRESETS[cli.device];
    if (!preset) {
      console.error(`--device=${cli.device} is not a known device. Valid: ${Object.keys(MOBILE_PRESETS).join(', ')}.`);
      process.exit(1);
    }
    deviceProfileName = cli.device;
    deviceProfile = preset;
  } else if (cli.mobile) {
    deviceProfileName = DEFAULT_MOBILE_PRESET;
    deviceProfile = MOBILE_PRESETS[DEFAULT_MOBILE_PRESET];
  }

  const devtools = Boolean(cli.devtools);
  const pauseOnAlarm = Boolean(cli['pause-on-alarm']);
  // Popping DevTools open, or pausing only for alarms, only makes sense if
  // you're actually there to look — both imply --manual.
  const manual = Boolean(cli.manual || devtools || pauseOnAlarm);
  // Manual inspection needs a visible window — --manual implies --headed.
  const headless = (cli.headed || manual) ? false : TOOL_DEFAULTS.headless;
  // --headed alone still keeps the window out of your way off-screen; --manual
  // means you need to actually see and click on it, so never push it off-screen.
  const pushOffscreen = TOOL_DEFAULTS.windowOffscreen && !manual;

  return {
    targets, intervalMs, jitterMs, alarmGapMs, alarmGapRatio,
    networkProfileName, networkProfile, deviceProfileName, deviceProfile,
    headless, manual, pushOffscreen, devtools, pauseOnAlarm,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function shortId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function round(n) {
  return typeof n === 'number' && !Number.isNaN(n) ? Math.round(n) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return null;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, Math.min(sortedArr.length - 1, idx))];
}

function stats(values) {
  const clean = values.filter((v) => typeof v === 'number' && !Number.isNaN(v));
  if (clean.length === 0) return { count: 0, avg: null, min: null, max: null, p75: null, p90: null };
  const sorted = [...clean].sort((a, b) => a - b);
  const avg = clean.reduce((a, b) => a + b, 0) / clean.length;
  return {
    count: clean.length,
    avg: round(avg),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
  };
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function launchBrowser(headless, pushOffscreen, devtools) {
  const args = [
    // Chromium sets navigator.webdriver=true by default when automated; this
    // is the single most common automation tell, so we suppress it. Everything
    // else (TLS fingerprint, HTTP2 settings, Accept/sec-ch-ua headers) comes
    // from the real, unmodified Chrome binary.
    '--disable-blink-features=AutomationControlled',
  ];
  if (!headless && pushOffscreen) args.push('--window-position=10000,0');
  if (devtools) args.push('--auto-open-devtools-for-tabs');
  const browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args,
  });

  // viewport: null disables Playwright's own device-metrics override (its
  // default is a fixed 1280x720 emulated viewport) — without this, Chrome's
  // window.screen.* properties report that emulated size, not the real host
  // display, no matter how big the actual screen is. This bit us directly:
  // every probe read exactly 1280x720 regardless of real screen size, since
  // that's Playwright's own default, not anything about the display.
  const probeContext = await browser.newContext({ viewport: null });
  const probePage = await probeContext.newPage();
  const rawUA = await probePage.evaluate(() => navigator.userAgent);
  // Real available screen size, so a headed window can be sized to actually
  // fit it — a fixed guess doesn't work across different screens, and even
  // matching the screen's own dimensions isn't enough: Chrome's own window
  // chrome (title bar/tabs/toolbar) adds real height on top of the content
  // viewport, which is what pushed a naive 1280x800 window off a 1280x800
  // display in testing.
  const screen = await probePage.evaluate(() => ({
    availWidth: window.screen.availWidth,
    availHeight: window.screen.availHeight,
  }));
  await probeContext.close();

  // Headless Chrome's UA contains "HeadlessChrome/<version>" instead of
  // "Chrome/<version>" — a no-op when already headed, but when headless this
  // keeps the real Chrome version while removing the one concrete tell, since
  // every real navigation uses this string as its UA override anyway.
  const realUA = rawUA.replace('HeadlessChrome/', 'Chrome/');

  const CHROME_HEIGHT_MARGIN = 120; // title bar + tab strip + toolbar
  const CHROME_WIDTH_MARGIN = 40;
  const MIN_HEADED_VIEWPORT = { width: 800, height: 600 }; // stays usable even on a small screen
  // No fixed upper cap — screen.availWidth/availHeight are already in
  // logical/CSS pixels (same unit macOS uses for window sizing, unaffected
  // by Retina/device pixel ratio), so subtracting the chrome margin already
  // gives a window that fits. An earlier version also capped this at a flat
  // 1280x800 "to be safe," which instead made the window look tiny on any
  // screen with a larger logical resolution than that (most modern laptops).
  const headedViewport = {
    width: Math.max(MIN_HEADED_VIEWPORT.width, screen.availWidth - CHROME_WIDTH_MARGIN),
    height: Math.max(MIN_HEADED_VIEWPORT.height, screen.availHeight - CHROME_HEIGHT_MARGIN),
  };

  return { browser, realUA, headedViewport, screen };
}

// Rewrites the real desktop UA into the equivalent Chrome-for-Android format,
// keeping the REAL Chrome/<version> token intact rather than hardcoding one —
// a stale hardcoded version would mismatch the actual TLS/engine behavior of
// the Chrome binary that's really making the request.
function toMobileUA(desktopUA, deviceProfile) {
  const versionMatch = desktopUA.match(/Chrome\/([\d.]+)/);
  const chromeVersion = versionMatch ? versionMatch[1] : '120.0.0.0';
  return `Mozilla/5.0 (Linux; Android ${deviceProfile.androidVersion}; ${deviceProfile.deviceModel}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36`;
}

function buildTaggedUA(realUA, deviceProfile) {
  const base = deviceProfile ? toMobileUA(realUA, deviceProfile) : realUA;
  return `${base} ${SITE.uaSuffix}`;
}

async function hitOnce(browser, target, id, userAgent, alarmGapMs, alarmGapRatio, networkProfileName, networkProfile, deviceProfileName, deviceProfile, manual, devtools, headless, headedViewport, pauseOnAlarm) {
  const timestamp = nowIso();
  const url = new URL(target.url);
  url.searchParams.set(SITE.queryParam, id);

  const record = {
    timestamp,
    request_id: id,
    target: target.name,
    url: url.toString(),
    network_profile: networkProfileName,
    device_profile: deviceProfileName,
    status: null,
    page_title: null,
    error: null,
    ttfb_ms: null,
    wait_ms: null,
    dns_ms: null,
    connect_ms: null,
    tls_ms: null,
    download_ms: null,
    total_ms: null,
    redirect_ms: null,
    protocol: null,
    server_timing: null,
    server_ms: null,
    gap_ms: null,
    gap_ratio: null,
    alarm: false,
    alarm_reason: null,
  };

  let context;
  let page;
  let stayOpen = false;
  try {
    // Fresh context per request: separate cookie jar/cache/connection
    // partition, so every hit approximates a first-time visitor rather than
    // reusing a warm connection from the previous request.
    context = await browser.newContext({
      userAgent,
      locale: SITE.locale,
      timezoneId: SITE.timezoneId,
      viewport: deviceProfile ? deviceProfile.viewport : (headless ? TOOL_DEFAULTS.viewport : headedViewport),
      deviceScaleFactor: deviceProfile ? deviceProfile.deviceScaleFactor : 1,
      isMobile: Boolean(deviceProfile),
      hasTouch: Boolean(deviceProfile),
      // Sent with every request from this context, including the doc call —
      // config-configurable so different brands can add their own identifying
      // header (e.g. a bypass token for a WAF rule) without editing this file.
      extraHTTPHeaders: SITE.headers,
    });
    page = await context.newPage();

    if (devtools) {
      // --auto-open-devtools-for-tabs opens DevTools asynchronously, racing
      // our own immediate navigation — without this wait, the document
      // request (the one thing you actually want to see) fires before
      // DevTools has finished attaching and starts recording, and is gone
      // for good (Network panel doesn't retroactively show missed events).
      await waitForDevtoolsAttach(context, page);
    }

    if (networkProfile) {
      // Same CDP call Chrome DevTools' own Network tab throttling uses, so
      // this affects the full request lifecycle (connect/TLS/response/
      // download) exactly as a real slow connection would, not just a fixed
      // delay tacked onto the end.
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: networkProfile.rttMs,
        downloadThroughput: (networkProfile.downloadKbps * 1000) / 8,
        uploadThroughput: (networkProfile.uploadKbps * 1000) / 8,
      });
    }

    // domcontentloaded, not load: TTFB/DNS/connect/TLS/download all come from
    // the main document's own Navigation Timing entry, fixed well before this
    // event fires — waiting for the full `load` event (all images/CSS/JS)
    // adds no accuracy but, under throttling, can make an otherwise-instant
    // TTFB reading fail with a timeout because unrelated subresources are slow.
    const response = await page.goto(url.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: TOOL_DEFAULTS.navigationTimeoutMs,
    });

    record.status = response ? response.status() : null;
    record.page_title = await page.title().catch(() => null);

    const nav = await page.evaluate(() => {
      const [entry] = performance.getEntriesByType('navigation');
      if (!entry) return null;
      return {
        redirectStart: entry.redirectStart,
        redirectEnd: entry.redirectEnd,
        domainLookupStart: entry.domainLookupStart,
        domainLookupEnd: entry.domainLookupEnd,
        connectStart: entry.connectStart,
        connectEnd: entry.connectEnd,
        secureConnectionStart: entry.secureConnectionStart,
        requestStart: entry.requestStart,
        responseStart: entry.responseStart,
        responseEnd: entry.responseEnd,
        nextHopProtocol: entry.nextHopProtocol,
        serverTiming: (entry.serverTiming || []).map((s) => ({ name: s.name, duration: s.duration })),
      };
    });

    if (nav) {
      record.ttfb_ms = round(nav.responseStart);
      record.wait_ms = round(nav.responseStart - nav.requestStart);
      record.dns_ms = round(nav.domainLookupEnd - nav.domainLookupStart);
      record.connect_ms = round(nav.connectEnd - nav.connectStart);
      record.tls_ms = nav.secureConnectionStart > 0 ? round(nav.connectEnd - nav.secureConnectionStart) : 0;
      record.download_ms = round(nav.responseEnd - nav.responseStart);
      record.total_ms = round(nav.responseEnd);
      record.redirect_ms = round(nav.redirectEnd - nav.redirectStart);
      record.protocol = nav.nextHopProtocol;
      record.server_timing = nav.serverTiming;

      const serverEntry = SITE.serverTimingMetric
        ? nav.serverTiming.find((s) => s.name === SITE.serverTimingMetric)
        : null;
      if (serverEntry) {
        record.server_ms = round(serverEntry.duration);
        if (record.ttfb_ms !== null && record.server_ms !== null) {
          record.gap_ms = record.ttfb_ms - record.server_ms;
          record.gap_ratio = record.server_ms > 0 ? Number((record.ttfb_ms / record.server_ms).toFixed(2)) : null;
          const gapTripped = record.gap_ms >= alarmGapMs;
          const ratioTripped = record.gap_ratio !== null && record.gap_ratio >= alarmGapRatio;
          record.alarm = gapTripped || ratioTripped;
          record.alarm_reason = record.alarm
            ? [gapTripped && 'gap', ratioTripped && 'ratio'].filter(Boolean).join('+')
            : null;
        }
      }
    }
  } catch (err) {
    record.error = err.message;
  } finally {
    // In manual mode, leave the context open for the caller to hand to the
    // human and close only once they're done inspecting — auto-closing here
    // would defeat the whole point. With --pause-on-alarm, that only holds
    // for hits that actually tripped an alarm; anything else closes and
    // proceeds automatically like a normal run.
    stayOpen = manual && (!pauseOnAlarm || record.alarm);
    if (context && !stayOpen) await context.close().catch(() => {});
  }

  return { record, context: stayOpen ? context : null, page: stayOpen ? page : null };
}

// Resolves once the human closes the inspected tab (page 'close') or quits
// the whole browser app (browser 'disconnected') — whichever happens first —
// with which one it was, rather than leaving the caller to re-poll
// browser.isConnected() afterward (there's a window right after the browser
// process exits where that can still read stale). Explicitly removes both
// listeners either way so a long manual session doesn't accumulate dangling
// listeners across requests.
function waitForManualClose(page, browser) {
  return new Promise((resolve) => {
    function done(cause) {
      page.off('close', onClose);
      browser.off('disconnected', onDisconnected);
      resolve(cause);
    }
    function onClose() { done('page'); }
    function onDisconnected() { done('browser'); }
    page.once('close', onClose);
    browser.once('disconnected', onDisconnected);
  });
}

// --auto-open-devtools-for-tabs opens DevTools frontend as its own CDP
// target, asynchronously — Playwright doesn't expose it as a Page (it's not
// a regular page target), so we poll the raw CDP Target list for a
// devtools:// target to show up instead of guessing a fixed delay. A small
// buffer after that covers the gap between "target exists" and "its Network
// panel has actually started recording," which isn't independently observable.
async function waitForDevtoolsAttach(context, page, timeoutMs = 3000) {
  const cdp = await context.newCDPSession(page);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    if (targetInfos.some((t) => t.url.startsWith('devtools://'))) {
      await sleep(300);
      return;
    }
    await sleep(100);
  }
}

function logRequest(r, csvPath, jsonlPath) {
  const csvLine = [
    r.timestamp, r.request_id, r.target, csvEscape(r.url), r.network_profile, r.device_profile, r.status,
    r.ttfb_ms, r.server_ms, r.gap_ms, r.gap_ratio, r.alarm ? 1 : 0, csvEscape(r.alarm_reason),
    r.wait_ms, r.dns_ms, r.connect_ms, r.tls_ms,
    r.download_ms, r.total_ms, r.redirect_ms, r.protocol,
    csvEscape(r.page_title), csvEscape(r.error),
  ].map((v) => (v === null || v === undefined ? '' : v)).join(',');
  fs.appendFileSync(csvPath, csvLine + '\n');
  fs.appendFileSync(jsonlPath, JSON.stringify(r) + '\n');

  if (r.error) {
    console.log(`[${r.timestamp}] id=${r.request_id} target=${r.target} ERROR: ${r.error}`);
    return;
  }

  const netStr = r.network_profile === 'none' ? '' : ` net=${r.network_profile}`;
  const deviceStr = r.device_profile === 'desktop' ? '' : ` device=${r.device_profile}`;

  // Three lines per hit, each a different kind of fact, so they're never
  // mistaken for one another at a glance: identity (headline, never styled —
  // even when alarming, it's not the fact that's alarming), the metrics that
  // actually matter (buildMetricsLine — shared with the final summary's "Top
  // 5 gaps" so both look identical), then the DNS/connect/TLS/wait/download
  // breakdown (buildBreakdownLine) indented further and prefixed with "↳" to
  // read as "detail of the above" instead of competing with it for attention.
  const headline = `[${r.timestamp}] ${r.target}${netStr}${deviceStr} status=${r.status} id=${r.request_id} proto=${r.protocol} "${r.page_title}"`;
  const metrics = buildMetricsLine(r);
  const breakdown = buildBreakdownLine(r);

  if (r.alarm) {
    console.log(alarmize(`!! ALARM (${r.alarm_reason}) !!`));
    console.log(headline);
    console.log(alarmize(metrics));
    console.log(alarmize(breakdown));
  } else {
    console.log(headline);
    console.log(metrics);
    console.log(breakdown);
  }
}

function printRunningAggregate(results) {
  const ok = results.filter((r) => !r.error);
  const ttfb = stats(ok.map((r) => r.ttfb_ms));
  const server = stats(ok.map((r) => r.server_ms).filter((v) => v !== null));
  const gap = stats(ok.map((r) => r.gap_ms).filter((v) => v !== null));
  const alarms = ok.filter((r) => r.alarm).length;
  // Dimmed throughout (a running computed average, not a fact about this
  // specific hit, and should never be mistaken for one at a glance) except
  // the three metric names, which are also bolded so they still anchor the
  // eye while scanning down a column of these. Built from small
  // self-contained dim/bold segments rather than one wrapped dimize() call —
  // a bold segment's own reset code would otherwise cancel dim for
  // everything after it, since ANSI codes aren't nested/scoped.
  // avg+p75 for all three, uniformly — ttfb's p75 matches the CWV/CrUX field
  // convention this whole tool exists to compare against; prism-server-rtt
  // and gap have no equivalent convention of their own, so they just get the
  // same treatment for consistency rather than an arbitrary different pair.
  console.log(
    `${dimize(`   Σ n=${results.length} (errors=${results.length - ok.length}, alarms=${alarms})`)}  ` +
    `${boldDim('ttfb')}${dimize(` avg=${fmtMs(ttfb.avg)} p75=${fmtMs(ttfb.p75)}`)}  ` +
    `${boldDim(METRIC_LABEL)}${dimize(` avg=${fmtMs(server.avg)} p75=${fmtMs(server.p75)}`)}  ` +
    `${boldDim('gap')}${dimize(` avg=${fmtMs(gap.avg)} p75=${fmtMs(gap.p75)}`)}`
  );
}

function buildSummary(results, runId, targets) {
  const byTarget = {};
  for (const t of targets) {
    const subset = results.filter((r) => r.target === t.name && !r.error);
    const errors = results.filter((r) => r.target === t.name && r.error).length;
    const withServerTiming = subset.filter((r) => r.server_ms !== null);
    byTarget[t.name] = {
      url: t.url,
      count: subset.length,
      errors,
      alarms: subset.filter((r) => r.alarm).length,
      missingServerTiming: subset.length - withServerTiming.length,
      ttfb_ms: stats(subset.map((r) => r.ttfb_ms)),
      server_ms: stats(withServerTiming.map((r) => r.server_ms)),
      gap_ms: stats(withServerTiming.map((r) => r.gap_ms)),
      wait_ms: stats(subset.map((r) => r.wait_ms)),
      dns_ms: stats(subset.map((r) => r.dns_ms)),
      connect_ms: stats(subset.map((r) => r.connect_ms)),
      tls_ms: stats(subset.map((r) => r.tls_ms)),
      download_ms: stats(subset.map((r) => r.download_ms)),
    };
  }
  const successful = results.filter((r) => !r.error);
  const withServerTimingAll = successful.filter((r) => r.server_ms !== null);
  // Every alarming hit, always — not just whichever ones happen to also have
  // the largest raw gap_ms. Alarm is OR-triggered (gap OR ratio), so a
  // ratio-triggered alarm can have a smaller absolute gap than some other
  // hit that never crossed either threshold; a pure "top 5 by gap size" sort
  // could silently drop real alarms in favor of bigger-but-fine gaps. Below
  // NOTABLE_GAPS_TARGET alarms, pad with the next-worst non-alarming hits so
  // there's still something to compare against; at or above it, show all of
  // them with no cap — this section's job is "show every alarm," not "show
  // exactly 5." Note the padding pool is drawn only from hits that HAD
  // Server-Timing data (gap/alarm aren't computable without it) — a target
  // with no Server-Timing metric at all contributes zero candidates here,
  // which can mean fewer than NOTABLE_GAPS_TARGET total even when padding
  // was "wanted" (see missingServerTimingPadPool below).
  const alarmingSorted = withServerTimingAll.filter((r) => r.alarm).sort((a, b) => b.gap_ms - a.gap_ms);
  const nonAlarmingSorted = withServerTimingAll.filter((r) => !r.alarm).sort((a, b) => b.gap_ms - a.gap_ms);
  const notableGaps = [
    ...alarmingSorted,
    ...(alarmingSorted.length < NOTABLE_GAPS_TARGET ? nonAlarmingSorted.slice(0, NOTABLE_GAPS_TARGET - alarmingSorted.length) : []),
  ]
    .map((r) => ({
      timestamp: r.timestamp,
      request_id: r.request_id,
      target: r.target,
      alarm: r.alarm,
      alarm_reason: r.alarm_reason,
      ttfb_ms: r.ttfb_ms,
      server_ms: r.server_ms,
      gap_ms: r.gap_ms,
      gap_ratio: r.gap_ratio,
      dns_ms: r.dns_ms,
      connect_ms: r.connect_ms,
      tls_ms: r.tls_ms,
      wait_ms: r.wait_ms,
      download_ms: r.download_ms,
      redirect_ms: r.redirect_ms,
    }));

  return {
    runId,
    startedAt: results[0]?.timestamp ?? null,
    endedAt: results[results.length - 1]?.timestamp ?? null,
    totalRequests: results.length,
    totalErrors: results.length - successful.length,
    totalAlarms: successful.filter((r) => r.alarm).length,
    missingServerTimingCount: successful.length - withServerTimingAll.length,
    overall: {
      ttfb_ms: stats(successful.map((r) => r.ttfb_ms)),
      server_ms: stats(withServerTimingAll.map((r) => r.server_ms)),
      gap_ms: stats(withServerTimingAll.map((r) => r.gap_ms)),
      wait_ms: stats(successful.map((r) => r.wait_ms)),
    },
    notableGaps,
    eligibleNonAlarmingCount: nonAlarmingSorted.length,
    byTarget,
  };
}

function printFinalSummary(summary) {
  console.log('');
  boxTop('Final summary');
  boxLine('Run', summary.runId);
  boxLine('Time span', `${summary.startedAt} → ${summary.endedAt}`);
  boxLine('Requests', `${summary.totalRequests}  (errors=${summary.totalErrors}, alarms=${summary.totalAlarms}, missing Server-Timing=${summary.missingServerTimingCount})`);
  boxBottom();
  console.log('');

  // Primary comparison table: avg+p75 for the same three metrics the live
  // per-request aggregate line uses, for the same reason (ttfb's p75 matches
  // the CWV/CrUX field convention; server/gap get the same pair just for
  // consistency, not because either has its own standard percentile). One
  // row per target plus an "Overall" row, so multi-target runs can actually
  // be compared at a glance instead of scrolling between per-target blocks.
  const targetNames = Object.keys(summary.byTarget);
  renderTable(
    ['Target', 'n', 'err', 'alarms', 'TTFB avg', 'TTFB p75', `${METRIC_LABEL} avg`, `${METRIC_LABEL} p75`, 'Gap avg', 'Gap p75'],
    [
      [
        'Overall', summary.totalRequests - summary.totalErrors, summary.totalErrors, summary.totalAlarms,
        fmtMs(summary.overall.ttfb_ms.avg), fmtMs(summary.overall.ttfb_ms.p75),
        fmtMs(summary.overall.server_ms.avg), fmtMs(summary.overall.server_ms.p75),
        fmtMs(summary.overall.gap_ms.avg), fmtMs(summary.overall.gap_ms.p75),
      ],
      ...targetNames.map((name) => {
        const s = summary.byTarget[name];
        return [
          name, s.count, s.errors, s.alarms,
          fmtMs(s.ttfb_ms.avg), fmtMs(s.ttfb_ms.p75),
          fmtMs(s.server_ms.avg), fmtMs(s.server_ms.p75),
          fmtMs(s.gap_ms.avg), fmtMs(s.gap_ms.p75),
        ];
      }),
    ],
    ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r']
  );
  console.log('');

  // Secondary table (dimmed, same treatment as the live breakdown line) —
  // where the TTFB above is actually going, not the headline comparison.
  const breakdownRows = targetNames
    .filter((name) => summary.byTarget[name].count > 0)
    .map((name) => {
      const s = summary.byTarget[name];
      return [name, fmtMs(s.dns_ms.avg), fmtMs(s.connect_ms.avg), fmtMs(s.tls_ms.avg), fmtMs(s.wait_ms.avg)];
    });
  if (breakdownRows.length > 0) {
    renderTable(
      ['Target', 'DNS avg', 'Connect avg', 'TLS avg', 'Wait avg'],
      breakdownRows,
      ['l', 'r', 'r', 'r', 'r'],
      { headerStyle: boldDim, rowStyle: dimize }
    );
    console.log('');
  }

  if (summary.notableGaps.length > 0) {
    // Every alarm this run, plus enough of the next-worst non-alarming hits
    // to give the alarms some context to compare against (if there were
    // fewer than 5 alarms) — not just the 5 largest gaps regardless of
    // whether they alarmed. Same headline/metrics/breakdown shape and
    // styling as the live log (via the shared buildMetricsLine/
    // buildBreakdownLine), so an entry here looks exactly like it did when
    // it scrolled by live.
    const alarmCount = summary.notableGaps.filter((g) => g.alarm).length;
    let title;
    let caveat = null;
    if (alarmCount === summary.notableGaps.length) {
      // Fewer than NOTABLE_GAPS_TARGET alarms but nothing to pad with isn't
      // the same situation as "there just weren't 5 alarms" — say so, or it
      // silently looks identical to the padding logic having done nothing.
      const padWanted = alarmCount < NOTABLE_GAPS_TARGET;
      if (padWanted && summary.eligibleNonAlarmingCount === 0) {
        caveat = 'No non-alarming hits with Server-Timing data available to pad with';
      }
      title = `All ${alarmCount} alarming gaps (TTFB − ${METRIC_LABEL}), worst first`;
    } else {
      title = `${alarmCount} alarming gap${alarmCount === 1 ? '' : 's'} + ${summary.notableGaps.length - alarmCount} next-worst (TTFB − ${METRIC_LABEL}), worst first within each`;
    }
    console.log(boldize(title));
    if (caveat) console.log(`(${caveat})`);
    for (const g of summary.notableGaps) {
      const tag = g.alarm ? `[ALARM: ${g.alarm_reason}]` : '[below threshold]';
      const headline = `${tag} [${g.timestamp}] ${g.target} id=${g.request_id}`;
      console.log(headline);
      console.log(g.alarm ? alarmize(buildMetricsLine(g)) : buildMetricsLine(g));
      console.log(g.alarm ? alarmize(buildBreakdownLine(g)) : buildBreakdownLine(g));
    }
    console.log('');
  }
}

async function main() {
  const {
    targets, intervalMs, jitterMs, alarmGapMs, alarmGapRatio,
    networkProfileName, networkProfile, deviceProfileName, deviceProfile,
    headless, manual, pushOffscreen, devtools, pauseOnAlarm,
  } = resolveRuntimeConfig(rawArgv);

  fs.mkdirSync(TOOL_DEFAULTS.logDir, { recursive: true });
  const runId = nowIso().replace(/[:.]/g, '-');
  const csvPath = path.join(TOOL_DEFAULTS.logDir, `requests-${runId}.csv`);
  const jsonlPath = path.join(TOOL_DEFAULTS.logDir, `requests-${runId}.jsonl`);
  const summaryPath = path.join(TOOL_DEFAULTS.logDir, `summary-${runId}.json`);

  fs.writeFileSync(
    csvPath,
    'timestamp,request_id,target,url,network_profile,device_profile,status,ttfb_ms,server_ms,gap_ms,gap_ratio,alarm,alarm_reason,wait_ms,dns_ms,connect_ms,tls_ms,download_ms,total_ms,redirect_ms,protocol,page_title,error\n'
  );

  boxTop('⏱️  Chronoscope run configuration');
  boxLine('Site', `${SITE.name}  (config: ${SITE.configPath})`);
  boxLine('Targets', targets.map((t) => t.name).join(', '));
  boxLine('Interval', `${intervalMs / 1000}s ± ${jitterMs / 1000}s jitter`);
  boxLine('Alarm', SITE.serverTimingMetric
    ? `gap ≥ ${alarmGapMs}ms OR ratio ≥ ${alarmGapRatio}x  (metric: ${SITE.serverTimingMetric})`
    : 'disabled — no serverTimingMetric configured (TTFB still measured)');
  boxLine('Network', networkProfile
    ? `${networkProfileName}  (rtt=${networkProfile.rttMs}ms down=${networkProfile.downloadKbps}kbps up=${networkProfile.uploadKbps}kbps)`
    : 'none — real, unrestricted connection');
  boxLine('Device', deviceProfile
    ? `${deviceProfileName} — ${deviceProfile.label}  (${deviceProfile.viewport.width}x${deviceProfile.viewport.height} @${deviceProfile.deviceScaleFactor}x, touch)`
    : 'desktop');
  if (manual) {
    boxLine('Mode', (pauseOnAlarm
      ? 'manual, alarms-only — pauses only on hits that trip an alarm'
      : 'manual — pauses after every hit, no timed interval') +
      (devtools ? '; DevTools auto-opens' : ''));
  }

  const results = [];
  let shuttingDown = false;

  // Playwright installs its own SIGINT/SIGTERM handler to kill the spawned
  // Chrome process, which calls process.exit() itself shortly after the
  // signal — racing our own cleanup. To win that race, this handler must be
  // registered before launchBrowser() (Node calls same-event listeners in
  // registration order) and must do all critical work SYNCHRONOUSLY, with no
  // `await`, before calling process.exit() ourselves. Any in-flight request
  // is simply abandoned; the summary reflects whatever completed so far.
  function finalizeAndExit(exitCode) {
    if (shuttingDown) {
      process.exit(exitCode);
      return;
    }
    shuttingDown = true;
    console.log('\nStopping — writing final summary from requests completed so far...');
    const summary = buildSummary(results, runId, targets);
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    printFinalSummary(summary);
    console.log(`Per-request CSV:   ${csvPath}`);
    console.log(`Per-request JSONL: ${jsonlPath}`);
    console.log(`Summary JSON:      ${summaryPath}`);
    process.exit(exitCode);
  }
  process.on('SIGINT', () => finalizeAndExit(0));
  process.on('SIGTERM', () => finalizeAndExit(0));

  let { browser, realUA, headedViewport, screen } = await launchBrowser(headless, pushOffscreen, devtools);
  let taggedUA = buildTaggedUA(realUA, deviceProfile);
  boxLine('Chrome', `real installed Chrome (not Playwright's bundled Chromium), headless=${headless}`);
  if (!headless && screen) {
    boxLine('Screen', `${screen.availWidth}x${screen.availHeight} available → window ${headedViewport.width}x${headedViewport.height}`);
  }
  boxLine('User-Agent', taggedUA);
  boxBottom();

  while (true) {
    for (const target of targets) {
      if (!browser.isConnected()) {
        console.log('Chrome disconnected unexpectedly, relaunching...');
        ({ browser, realUA, headedViewport } = await launchBrowser(headless, pushOffscreen, devtools));
        taggedUA = buildTaggedUA(realUA, deviceProfile);
      }

      const id = shortId();
      let { record, context, page } = await hitOnce(
        browser, target, id, taggedUA, alarmGapMs, alarmGapRatio,
        networkProfileName, networkProfile, deviceProfileName, deviceProfile, manual, devtools, headless, headedViewport, pauseOnAlarm
      );
      // A dead browser connection (most likely after a manual-mode Chrome
      // quit — real Chrome's shutdown can leave it in a zombie state for
      // several seconds, neither usable nor yet reporting disconnected)
      // shouldn't cost this request a permanent error: relaunch and redo it
      // once rather than recording a spurious failure and moving on.
      if (record.error && (!browser.isConnected() || /closed|disconnected/i.test(record.error))) {
        console.log('Chrome connection was lost — relaunching and retrying this request...');
        ({ browser, realUA, headedViewport } = await launchBrowser(headless, pushOffscreen, devtools));
        taggedUA = buildTaggedUA(realUA, deviceProfile);
        ({ record, context, page } = await hitOnce(
          browser, target, id, taggedUA, alarmGapMs, alarmGapRatio,
          networkProfileName, networkProfile, deviceProfileName, deviceProfile, manual, devtools, headless, headedViewport, pauseOnAlarm
        ));
      }
      results.push(record);
      logRequest(record, csvPath, jsonlPath);
      printRunningAggregate(results);

      // page/context are only non-null here if hitOnce() decided this hit
      // should stay open — already accounts for --pause-on-alarm, so no need
      // to re-check manual/alarm status here.
      if (page && context) {
        console.log(boldize(`>>> Chrome is open for "${target.name}" — close the window (or quit Chrome) to continue to the next request.\n`));
        const closedVia = await waitForManualClose(page, browser);
        if (closedVia === 'browser') console.log('Chrome was quit.');
        // Real Chrome's shutdown (updater/crash-reporter cleanup, etc.) can
        // take a while after its last window closes — the browser can be in
        // a zombie state (page gone, but not yet reporting disconnected)
        // for several seconds. Rather than race that, just try; the retry
        // logic below relaunches and redoes this request if it turns out dead.
        await context.close().catch(() => {});
        console.log('');
      } else {
        console.log('');
        const wait = intervalMs + (Math.random() * 2 - 1) * jitterMs;
        await sleep(Math.max(0, wait));
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
