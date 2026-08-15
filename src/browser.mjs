// Browser lifecycle: launching real Chrome, per-page setup, and the
// per-request hit itself.
import { chromium } from 'playwright';
import { TOOL_DEFAULTS } from './constants.mjs';
import { round, nowIso, sleep } from './util.mjs';

export async function launchBrowser(headless, pushOffscreen, devtools) {
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
    // Playwright's default SIGINT/SIGTERM handling kills the Chrome process
    // itself, racing our own SIGINT handler in main() and forcing an
    // immediate close no matter what we want to do on that signal. Disabling
    // it makes shutdown entirely our own responsibility (see finalizeAndExit)
    // — necessary so --new-tab-on-alarm can pause on a first Ctrl+C, leaving
    // Chrome and every kept-open tab untouched, instead of Playwright yanking
    // the whole browser out from under it regardless of what we decide.
    handleSIGINT: false,
    handleSIGTERM: false,
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
export function toMobileUA(desktopUA, deviceProfile) {
  const versionMatch = desktopUA.match(/Chrome\/([\d.]+)/);
  const chromeVersion = versionMatch ? versionMatch[1] : '120.0.0.0';
  return `Mozilla/5.0 (Linux; Android ${deviceProfile.androidVersion}; ${deviceProfile.deviceModel}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36`;
}

export function buildTaggedUA(realUA, deviceProfile, uaSuffix) {
  const base = deviceProfile ? toMobileUA(realUA, deviceProfile) : realUA;
  return `${base} ${uaSuffix}`;
}

// --auto-open-devtools-for-tabs opens DevTools frontend as its own CDP
// target, asynchronously — Playwright doesn't expose it as a Page (it's not
// a regular page target), so we poll the raw CDP Target list for a
// devtools:// target to show up instead of guessing a fixed delay. A small
// buffer after that covers the gap between "target exists" and "its Network
// panel has actually started recording," which isn't independently observable.
export async function waitForDevtoolsAttach(context, page, timeoutMs = 3000) {
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

// Config-configurable custom headers (e.g. a WAF bypass token or an
// internal-traffic marker) are attached only to requests whose origin
// matches the target's own — never to third-party subresources (fonts,
// analytics, ad scripts, etc.) pulled in by the page. Two independent
// reasons, either one would be enough on its own:
// 1. A non-safelisted header like this can fail a third party's own CORS
//    preflight outright (confirmed against real Google Fonts: Chrome blocks
//    the font request entirely with "Request header field x-host is not
//    allowed by Access-Control-Allow-Headers"), breaking page resources that
//    have nothing to do with what this header is actually for.
// 2. Even when a third party's CORS policy happens to allow it, an
//    internal/WAF-bypass header has no business being disclosed to a
//    service that isn't the one it's meant for.
// Registered once per context (not per-page) via context.route(), so it
// automatically covers every page in that context — including reused pages
// under --reuse-connection and new tabs under --new-tab-on-alarm — without
// needing to be set up again for each one.
export async function attachFirstPartyHeaders(context, targetUrl, headers) {
  if (!headers || Object.keys(headers).length === 0) return;
  const targetOrigin = new URL(targetUrl).origin;
  await context.route('**/*', (route) => {
    const isFirstParty = new URL(route.request().url()).origin === targetOrigin;
    if (isFirstParty) {
      route.continue({ headers: { ...route.request().headers(), ...headers } });
    } else {
      route.continue();
    }
  });
}

// One-time per-page setup: devtools attach + CDP throttle/cache-disable.
// Shared by hitOnce's initial page creation AND --new-tab-on-alarm's
// mid-run replacement page, so the two can't drift out of sync with each
// other — a new tab opened after an alarm needs exactly the same setup a
// brand-new run's first page gets, not a stripped-down version of it.
export async function setupPage(context, page, devtools, networkProfile, reuseConnection) {
  if (devtools) {
    // --auto-open-devtools-for-tabs opens DevTools asynchronously, racing
    // our own immediate navigation — without this wait, the document
    // request (the one thing you actually want to see) fires before
    // DevTools has finished attaching and starts recording, and is gone
    // for good (Network panel doesn't retroactively show missed events).
    await waitForDevtoolsAttach(context, page);
  }

  if (networkProfile || reuseConnection) {
    const cdp = await context.newCDPSession(page);
    if (networkProfile) {
      // Same CDP call Chrome DevTools' own Network tab throttling uses, so
      // this affects the full request lifecycle (connect/TLS/response/
      // download) exactly as a real slow connection would, not just a
      // fixed delay tacked onto the end.
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: networkProfile.rttMs,
        downloadThroughput: (networkProfile.downloadKbps * 1000) / 8,
        uploadThroughput: (networkProfile.uploadKbps * 1000) / 8,
      });
    }
    if (reuseConnection) {
      // Empty Cache and Hard Reload semantics — same CDP calls DevTools'
      // own hard-reload button uses (clear what's cached, then disable
      // the cache going forward) — but kept in effect for every
      // navigation on this page for the rest of the run, not a one-off
      // action. Doesn't touch the TCP connection itself, so connection
      // reuse (the whole point of this mode) is unaffected.
      await cdp.send('Network.clearBrowserCache');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    }
  }
}

export async function hitOnce(browser, target, id, userAgent, alarmGapMs, alarmGapRatio, networkProfileName, networkProfile, deviceProfileName, deviceProfile, manual, devtools, headless, headedViewport, pauseOnAlarm, disableJs, reuseConnection, persistent, site) {
  const timestamp = nowIso();
  const url = new URL(target.url);
  url.searchParams.set(site.queryParam, id);

  const record = {
    timestamp,
    request_id: id,
    target: target.name,
    url: url.toString(),
    network_profile: networkProfileName,
    device_profile: deviceProfileName,
    status: null,
    final_url: null,
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
    if (persistent) {
      // --reuse-connection: navigate the SAME page again instead of opening a
      // fresh context — Chrome keeps whatever connection it already
      // established to this origin, the same way a hand reload in an
      // already-open tab does. Nothing below that's tied to context/page
      // creation (devtools attach, CDP throttle) needs redoing.
      ({ context, page } = persistent);
    } else {
      // Fresh context per request: separate cookie jar/cache/connection
      // partition, so every hit approximates a first-time visitor rather than
      // reusing a warm connection from the previous request. (Not with
      // --reuse-connection — see above.)
      context = await browser.newContext({
        userAgent,
        locale: site.locale,
        timezoneId: site.timezoneId,
        viewport: deviceProfile ? deviceProfile.viewport : (headless ? TOOL_DEFAULTS.viewport : headedViewport),
        deviceScaleFactor: deviceProfile ? deviceProfile.deviceScaleFactor : 1,
        isMobile: Boolean(deviceProfile),
        hasTouch: Boolean(deviceProfile),
        // TTFB/DNS/connect/TLS/download all come from the Navigation Timing
        // entry for the document response — none of it depends on JS executing.
        // Disabling it removes JS-driven noise (redirects, client-side
        // rendering, third-party scripts) from a number that was never
        // supposed to depend on them.
        javaScriptEnabled: !disableJs,
      });
      await attachFirstPartyHeaders(context, target.url, site.headers);
      page = await context.newPage();
      await setupPage(context, page, devtools, networkProfile, reuseConnection);
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
    // page.url() reflects wherever navigation actually ended up — differs
    // from the requested `record.url` only when the target redirected.
    // Recorded unconditionally (cheap) since it's the only way to prove what
    // was actually tested, independent of whether --verbose surfaces it live.
    record.final_url = page.url();
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

      const serverEntry = site.serverTimingMetric
        ? nav.serverTiming.find((s) => s.name === site.serverTimingMetric)
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
    // proceeds automatically like a normal run. --reuse-connection always
    // stays open too — the caller hands it back into the next hitOnce() call
    // instead of waiting on a human.
    stayOpen = reuseConnection || (manual && (!pauseOnAlarm || record.alarm));
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
export function waitForManualClose(page, browser) {
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

// --reuse-connection --pause-on-alarm: the page itself never closes between
// hits (that would throw away the whole point — the warm connection), so
// resuming can't be "wait for the window to close" like plain --manual does.
// Wait for a terminal keypress (Enter) instead; the browser window is left
// exactly as it was for inspection.
export function waitForKeypress() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}
