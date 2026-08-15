// ⏱️ Chronoscope — webpage latency testing kit, driven by real installed Chrome.
//
// Site-specific detail (which URLs to hit, locale/timezone, the UA suffix,
// and the name of a Server-Timing metric to compare TTFB against) all comes
// from a JSON config file — see HELP_TEXT (src/help.mjs) for the schema, or
// run with --help. Nothing in this file (or src/) should need editing to
// point it at a different brand/site; only the config file should change.
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
//
// This file is the thin entry point/orchestrator: everything reusable lives
// in src/. Every src/ module is careful to have NO module-level side effects
// (config loading, --help, etc. only happen when explicitly called from
// here) — ES module imports are hoisted and fully executed before this
// file's own top-level code runs, so a module that loaded the config file
// (and possibly process.exit(1)'d) as a side effect of being imported would
// silently run BEFORE the --help check below, breaking "Bootstrap order
// matters" (see CLAUDE.md): --help must work even with no config present.

import fs from 'fs';
import path from 'path';
import { TOOL_DEFAULTS } from './src/constants.mjs';
import { HELP_TEXT, KNOWN_FLAGS } from './src/help.mjs';
import { parseArgs, resolveRuntimeConfig } from './src/cli.mjs';
import { findConfigPath, loadSiteConfig, flattenTestUrls, buildSite } from './src/config.mjs';
import { launchBrowser, buildTaggedUA, hitOnce, setupPage, waitForManualClose, waitForKeypress } from './src/browser.mjs';
import { boxTop, boxLine, boxBottom, boldize, logRequest, printRunningAggregate, printFinalSummary } from './src/output.mjs';
import { buildSummary } from './src/summary.mjs';
import { nowIso, shortId, sleep } from './src/util.mjs';

const rawArgv = process.argv.slice(2);
if (rawArgv.includes('--help')) {
  console.log(HELP_TEXT);
  process.exit(0);
}

// parseArgs() itself doesn't validate flag *names*, just extracts whatever
// --key=value pairs are present, so a typo like --reuse-connecton would
// otherwise be silently accepted and simply do nothing.
const unknownFlags = Object.keys(parseArgs(rawArgv)).filter((f) => !KNOWN_FLAGS.has(f));
if (unknownFlags.length > 0) {
  // Deliberately the very first thing printed, before config loading even
  // gets a chance to run (and possibly fail for an unrelated reason) — a
  // misspelled flag should never go unnoticed just because something else
  // happened to also go wrong in the same run. Hardcoded ANSI (bold red)
  // rather than the alarmize() helper (src/output.mjs): calling that would
  // mean importing src/output.mjs before this check, and it's cleaner for
  // this one bootstrap-time line to have zero dependency on load order.
  const plural = unknownFlags.length === 1 ? '' : 's';
  console.log(`\x1b[1m\x1b[31m!! Unrecognized flag${plural}: ${unknownFlags.map((f) => `--${f}`).join(', ')} — check spelling, or run --help for the full list. !!\x1b[0m`);
}

const configPath = findConfigPath(rawArgv);
const siteConfigRaw = loadSiteConfig(configPath);
const ALL_TARGETS = flattenTestUrls(siteConfigRaw.testUrls);
const SITE = buildSite(siteConfigRaw, configPath, TOOL_DEFAULTS);

// The actual configured metric name (e.g. "prism-server-rtt") reads better in
// logs/CSV than a generic "app-server" label — falls back to a generic label
// only when no serverTimingMetric is configured at all.
const METRIC_LABEL = SITE.serverTimingMetric || 'server-timing';

async function main() {
  const {
    targets, intervalMs, jitterMs, alarmGapMs, alarmGapRatio,
    networkProfileName, networkProfile, deviceProfileName, deviceProfile,
    headless, manual, pushOffscreen, devtools, pauseOnAlarm, disableJs, reuseConnection, newTabOnAlarm,
  } = resolveRuntimeConfig(rawArgv, ALL_TARGETS, SITE);

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
  if (disableJs) {
    boxLine('JavaScript', 'disabled — document timing only, no scripts execute on the page');
  }
  if (reuseConnection) {
    boxLine('Connection', targets.length === 1
      ? 'reused — one persistent page for the whole run (approximates a hand reload, not a first-time visitor)'
      : `reused — one persistent page per target (${targets.length} total), each approximating its own hand reload`);
  }
  if (manual && !reuseConnection) {
    boxLine('Mode', (pauseOnAlarm
      ? 'manual, alarms-only — pauses only on hits that trip an alarm'
      : 'manual — pauses after every hit, no timed interval') +
      (devtools ? '; DevTools auto-opens' : ''));
  }
  if (manual && reuseConnection) {
    boxLine('Mode', (pauseOnAlarm
      ? 'reuse-connection, alarms-only — pauses only on hits that trip an alarm'
      : 'reuse-connection, manual — pauses after every hit, no timed interval') +
      ' (same page — press Enter here to resume)' +
      (devtools ? '; DevTools auto-opens' : ''));
  }
  if (newTabOnAlarm) {
    boxLine('On alarm', 'keep this tab open and continue reloading on a fresh one — no pause, tabs accumulate for later inspection');
  }

  const results = [];
  let shuttingDown = false;
  // --new-tab-on-alarm only: true between a first Ctrl+C and either a resume
  // keypress or a second Ctrl+C. See the SIGINT handler and the pause check
  // in the main loop below.
  let paused = false;
  // Declared here (rather than at the `launchBrowser()` call below, where it
  // used to live) specifically so finalizeAndExit's `browser ? ... : ...`
  // check reads a real `undefined` instead of throwing — a SIGINT arriving
  // in the narrow window before launchBrowser() resolves (Chrome takes a
  // moment to start) would otherwise hit `browser` while it's still in the
  // temporal dead zone and crash instead of shutting down gracefully.
  let browser;

  // The critical file writes (summary JSON) still happen synchronously,
  // before anything async — that part of the original race concern doesn't
  // go away just because Playwright no longer competes for this signal.
  // What's new: since handleSIGINT/handleSIGTERM are now false in
  // launchBrowser(), Playwright will NOT close Chrome for us on this signal
  // — closing it ourselves is now required, not optional, and it's safe to
  // await that close here specifically because nothing else is racing this
  // exit anymore (unlike before, when Playwright's own competing handler
  // could fire process.exit() out from under an `await`).
  function finalizeAndExit(exitCode) {
    if (shuttingDown) {
      process.exit(exitCode);
      return;
    }
    shuttingDown = true;
    console.log('\nStopping — writing final summary from requests completed so far...');
    const summary = buildSummary(results, runId, targets);
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    printFinalSummary(summary, METRIC_LABEL, SITE.serverTimingMetric);
    console.log(`Per-request CSV:   ${csvPath}`);
    console.log(`Per-request JSONL: ${jsonlPath}`);
    console.log(`Summary JSON:      ${summaryPath}`);
    // No artificial timeout here — an earlier version raced this against a
    // 3s sleep(), which sounds like a reasonable safety net but isn't: real
    // Chrome shutdown can genuinely take a few seconds (see the "dead
    // browser connection" caveat elsewhere), so the race would sometimes
    // fire process.exit() before browser.close() actually finished,
    // orphaning the Chrome process entirely — confirmed via `ps aux` during
    // testing. `shuttingDown` above is the real escape hatch: if this
    // genuinely hangs, a second Ctrl+C exits immediately regardless.
    (browser ? browser.close().catch(() => {}) : Promise.resolve()).finally(() => process.exit(exitCode));
  }
  process.on('SIGINT', () => {
    // First Ctrl+C under --new-tab-on-alarm pauses instead of exiting —
    // debugging a tab is hard when new ones keep appearing mid-inspection,
    // and exiting outright was worse: it took every kept-open tab down with
    // it. A second Ctrl+C (paused already, so this branch is skipped) falls
    // through to a real, final finalizeAndExit.
    if (newTabOnAlarm && !paused && !shuttingDown) {
      paused = true;
      console.log(boldize('\n>>> Paused — Chrome and every kept-open tab remain exactly as they are. Press Enter here to resume, or Ctrl+C again to stop for good and write the final summary.\n'));
      return;
    }
    finalizeAndExit(0);
  });
  process.on('SIGTERM', () => finalizeAndExit(0));

  let realUA, headedViewport, screen;
  ({ browser, realUA, headedViewport, screen } = await launchBrowser(headless, pushOffscreen, devtools));
  let taggedUA = buildTaggedUA(realUA, deviceProfile, SITE.uaSuffix);
  boxLine('Chrome', `real installed Chrome (not Playwright's bundled Chromium), headless=${headless}`);
  if (!headless && screen) {
    boxLine('Screen', `${screen.availWidth}x${screen.availHeight} available → window ${headedViewport.width}x${headedViewport.height}`);
  }
  boxLine('User-Agent', taggedUA);
  boxBottom();

  // Only populated under --reuse-connection — one entry per target, each
  // holding that target's own dedicated {context, page}. hitOnce() hands
  // its context/page back here instead of closing them, and the next hit
  // for THAT SAME target passes it straight back in instead of opening a
  // fresh context — a different target gets its own separate entry, so
  // rotating through several targets never makes one target's connection
  // jump between origins. Cleared entirely whenever the browser itself gets
  // relaunched, since a dead browser takes every context/page with it.
  let persistentByTarget = new Map();
  // --new-tab-on-alarm: count of tabs currently kept open for inspection,
  // across all targets combined. Reset alongside `persistentByTarget` on a
  // browser relaunch — a dead Chrome takes every kept-open tab down with it,
  // so a stale count would be misleading.
  let newTabCount = 0;

  while (true) {
    for (const target of targets) {
      // --new-tab-on-alarm: block here, before firing the next hit, while
      // paused — an in-flight hit is never interrupted mid-request, only the
      // NEXT one is held back, so nothing gets abandoned half-done just to
      // honor a pause. Resumes on a keypress; a second Ctrl+C while paused
      // hits the `finalizeAndExit` branch of the SIGINT handler instead
      // (`paused` is already true there, so this loop is moot at that point
      // — process.exit() takes down everything, including this dangling wait).
      while (paused) {
        await waitForKeypress();
        if (paused) {
          paused = false;
          console.log(boldize('>>> Resuming...\n'));
        }
      }
      if (shuttingDown) return;

      if (!browser.isConnected()) {
        console.log('Chrome disconnected unexpectedly, relaunching...');
        ({ browser, realUA, headedViewport } = await launchBrowser(headless, pushOffscreen, devtools));
        taggedUA = buildTaggedUA(realUA, deviceProfile, SITE.uaSuffix);
        persistentByTarget.clear();
        newTabCount = 0;
      }

      const id = shortId();
      let { record, context, page } = await hitOnce(
        browser, target, id, taggedUA, alarmGapMs, alarmGapRatio,
        networkProfileName, networkProfile, deviceProfileName, deviceProfile, manual, devtools, headless, headedViewport, pauseOnAlarm, disableJs, reuseConnection, persistentByTarget.get(target.name), SITE
      );
      // A dead browser connection (most likely after a manual-mode Chrome
      // quit — real Chrome's shutdown can leave it in a zombie state for
      // several seconds, neither usable nor yet reporting disconnected)
      // shouldn't cost this request a permanent error: relaunch and redo it
      // once rather than recording a spurious failure and moving on.
      if (record.error && (!browser.isConnected() || /closed|disconnected/i.test(record.error))) {
        console.log('Chrome connection was lost — relaunching and retrying this request...');
        ({ browser, realUA, headedViewport } = await launchBrowser(headless, pushOffscreen, devtools));
        taggedUA = buildTaggedUA(realUA, deviceProfile, SITE.uaSuffix);
        persistentByTarget.clear();
        newTabCount = 0;
        ({ record, context, page } = await hitOnce(
          browser, target, id, taggedUA, alarmGapMs, alarmGapRatio,
          networkProfileName, networkProfile, deviceProfileName, deviceProfile, manual, devtools, headless, headedViewport, pauseOnAlarm, disableJs, reuseConnection, persistentByTarget.get(target.name), SITE
        ));
      }
      results.push(record);
      logRequest(record, csvPath, jsonlPath, METRIC_LABEL, SITE.serverTimingMetric);
      printRunningAggregate(results, METRIC_LABEL);

      if (reuseConnection) {
        // hitOnce() always hands the context/page back in this mode instead
        // of closing them — hold onto them so the next hit for THIS target
        // reuses the same (already-connected) page instead of opening a new
        // one. Keyed by target name so rotating through multiple targets
        // gives each one its own dedicated, independently warm connection.
        persistentByTarget.set(target.name, { context, page });
      }

      if (newTabOnAlarm && record.alarm) {
        // Leave this tab exactly as it is — if --devtools is active, its
        // Network panel still holds just this one alarming request,
        // untouched by any future reload — and open a fresh tab in the SAME
        // context to keep testing from. Same context, not a new one, so the
        // new tab still shares the reused connection's warm socket pool.
        newTabCount += 1;
        const newPage = await context.newPage();
        await setupPage(context, newPage, devtools, networkProfile, reuseConnection);
        persistentByTarget.set(target.name, { context, page: newPage });
        console.log(boldize(`>>> ALARM on "${target.name}" — keeping this tab open for inspection and continuing on a fresh one (${newTabCount} tab${newTabCount === 1 ? '' : 's'} kept open so far).\n`));
      }

      // Same "should this hit pause?" condition regardless of reuseConnection
      // — --pause-on-alarm restricts it to alarming hits, otherwise --manual
      // (or --devtools) pauses on every hit. What differs by reuseConnection
      // is HOW: close-and-reopen (plain --manual) vs. a terminal keypress on
      // the same never-closed page (--reuse-connection).
      const shouldPause = manual && (!pauseOnAlarm || record.alarm);
      if (shouldPause && reuseConnection) {
        console.log(boldize(`>>> ${record.alarm ? 'ALARM on' : 'Hit for'} "${target.name}" — Chrome is still open on the same page for you to inspect (DevTools, Network tab, whatever you need). Press Enter here to resume reloading.\n`));
        await waitForKeypress();
        console.log('');
      } else if (shouldPause) {
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
