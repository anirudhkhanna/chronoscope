// Pure, static data — no functions, no side effects, safe to import from
// anywhere without affecting module load order.

// CDP-level throttling (same mechanism Chrome DevTools' Network tab uses:
// Network.emulateNetworkConditions), so these numbers aren't guaranteed to
// match whatever your installed Chrome's DevTools UI currently ships as
// presets — those have shifted across versions (Chrome has periodically
// retuned them against real CrUX network distributions). Instead these are
// the long-standing Lighthouse/WebPageTest mobile throttling defaults, which
// are the most widely cited, stable reference points for "slow-4g"/"slow-3g".
// Override any of them with --network-rtt/--network-down/--network-up if you
// want exact numbers to match a spec you were given.
export const NETWORK_PRESETS = {
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
export const MOBILE_PRESETS = {
  pixel: { label: 'Pixel 7 (Android phone)', viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, androidVersion: '13', deviceModel: 'Pixel 7' },
  galaxy: { label: 'Galaxy S22 (Android phone)', viewport: { width: 360, height: 780 }, deviceScaleFactor: 3, androidVersion: '13', deviceModel: 'SM-S901B' },
  tablet: { label: 'Galaxy Tab S8 (Android tablet)', viewport: { width: 800, height: 1280 }, deviceScaleFactor: 2, androidVersion: '13', deviceModel: 'SM-X706B' },
};
export const DEFAULT_MOBILE_PRESET = 'pixel';

// Tool-level defaults: how a run behaves, not what site it's testing. None of
// these belong in the config file — they're re-chosen per invocation via CLI
// flags, not per brand.
export const TOOL_DEFAULTS = {
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

export const DEFAULT_CONFIG_PATH = 'latency-config.json';

// The final summary's "notable gaps" list shows every alarm, padded up to
// this many total with the next-worst non-alarming hits if there were fewer
// alarms than this.
export const NOTABLE_GAPS_TARGET = 5;
