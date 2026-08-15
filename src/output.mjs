// Console/file output formatting — the three visual registers (static run
// config box, live per-hit facts, dimmed computed aggregates), the CSV/JSONL
// writers, and the final summary. metricLabel/serverTimingMetric are passed
// in explicitly by the caller (derived once from the loaded SITE config)
// rather than imported as shared globals, so this module has no dependency
// on config-loading having already happened.
import fs from 'fs';
import { NOTABLE_GAPS_TARGET } from './constants.mjs';
import { stats } from './util.mjs';

export const ANSI = { red: '\x1b[31m', bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m' };
export function alarmize(str) {
  return `${ANSI.bold}${ANSI.red}${str}${ANSI.reset}`;
}
export function boldize(str) {
  return `${ANSI.bold}${str}${ANSI.reset}`;
}
export function dimize(str) {
  return `${ANSI.dim}${str}${ANSI.reset}`;
}
export function boldDim(str) {
  return `${ANSI.bold}${ANSI.dim}${str}${ANSI.reset}`;
}

export function fmtMs(v) {
  return v === null || v === undefined ? 'n/a' : `${v}ms`;
}

// Shared by the live per-request log and the final summary's "Top 5 gaps" —
// same underlying facts (ttfb/server/gap, or the DNS/connect/TLS/wait/
// download breakdown), so both should look identical rather than drifting
// into two similar-but-not-quite-matching formats. `alarm` decides styling:
// bold values only when not alarming (alarm lines get uniformly bold+red by
// the caller, which would conflict with inner styling — ANSI resets aren't
// nested/scoped, see the note in logRequest).
export function buildMetricsLine(rec, metricLabel, serverTimingMetric) {
  const ttfbVal = fmtMs(rec.ttfb_ms);
  const serverVal = rec.server_ms === null ? (serverTimingMetric ? 'MISSING' : 'n/a') : fmtMs(rec.server_ms);
  const gapVal = rec.gap_ms === null ? 'n/a' : fmtMs(rec.gap_ms);
  const gapRatioSuffix = rec.gap_ms === null ? '' : ` (${rec.gap_ratio}x)`;
  return rec.alarm
    ? `   ttfb :: ${ttfbVal}  ${metricLabel} :: ${serverVal}  |  gap :: ${gapVal}${gapRatioSuffix}`
    : `   ttfb :: ${boldize(ttfbVal)}  ${metricLabel} :: ${boldize(serverVal)}  |  gap :: ${boldize(gapVal)}${gapRatioSuffix}`;
}
// redirect= is prepended (not appended) since it happens chronologically
// before dns/connect/tls/wait of the final request — with it, the fields on
// this line actually sum to ttfb for a redirecting hit; without it, TTFB
// silently includes the redirect's full duration with nothing on this line
// accounting for it. Unlike dns/connect/tls (always shown, even at 0ms),
// this one is omitted entirely on a hit that genuinely didn't redirect
// (final_url === url) — an earlier draft always showed it, reasoning it
// should match dns/connect/tls's unconditional treatment, but that's not
// actually analogous: dns/connect/tls are core, load-bearing facts on every
// hit, while redirect is a real event that either happened or didn't, closer
// to the verbose "redirected →" line's own "omit when it's usually not true"
// reasoning than to dns/connect/tls's "always relevant" one.
//
// "hidden (cross-origin)" instead of a raw 0ms specifically when the target
// DID redirect (final_url !== url) but redirect_ms still reads 0 — this is a
// real, confirmed browser behavior, not our own display choice: per the
// Navigation Timing spec, redirectStart/redirectEnd are zeroed for JS when a
// redirect crosses origins (scheme or host change — http→https, apex→www)
// and that redirect response didn't send Timing-Allow-Origin, as a
// cross-origin-timing-attack protection. Confirmed directly: requesting
// http://dancenter.dk/dk (which real-world redirects through http→https and
// apex→www before landing on https://www.dancenter.dk/dk/) reports
// redirectCount: 0, redirectStart: 0, redirectEnd: 0 despite finalUrl proving
// multiple redirects happened. Printing a plain "0ms" there would claim the
// redirect cost nothing, when the truth is the browser won't tell JS what it
// cost — those are different facts and this line shouldn't blur them, and
// unlike the "genuinely no redirect" case, this one IS still worth surfacing
// every time it happens rather than omitted, since it's a real caveat about
// the numbers above it, not a non-event.
export function buildBreakdownLine(rec) {
  const redirected = rec.final_url && rec.final_url !== rec.url;
  let redirectPart = '';
  if (redirected && rec.redirect_ms === 0) {
    redirectPart = 'redirect=hidden (cross-origin) ';
  } else if (rec.redirect_ms > 0) {
    redirectPart = `redirect=${fmtMs(rec.redirect_ms)} `;
  }
  return `   ↳ ${redirectPart}dns=${fmtMs(rec.dns_ms)} connect=${fmtMs(rec.connect_ms)} tls=${fmtMs(rec.tls_ms)} ` +
    `wait=${fmtMs(rec.wait_ms)} download=${fmtMs(rec.download_ms)}`;
}

// --verbose's extra identity-class facts, shared by the live per-hit log and
// the final summary's notableGaps list for the same reason
// buildMetricsLine/buildBreakdownLine are shared — so an entry looks
// identical whether it's scrolling by live or read back after the fact.
//
// Split into two groups rather than one combined list: url/redirected sit
// flush left, right under the headline and above the page title — identity
// facts, same tier as the target name itself, and specifically NOT inline in
// the headline, since a 100+ char URL crammed into "target - status (...)"
// pushes the terminal's wrap point into the middle of unrelated fields; as
// its own line it wraps on its own without corrupting anything else. Neither
// line is indented — that's reserved for the computed facts below (metrics/
// breakdown/server-timing), so identity and computed read as two columns by
// indentation alone. Both lines are dimmed by the caller, same as the page
// title just below them — "where/what this was," not a number to scan for.
export function buildVerboseIdentityLines(rec) {
  const lines = [rec.url];
  if (rec.final_url && rec.final_url !== rec.url) {
    lines.push(`↳ redirected → ${rec.final_url}`);
  }
  return lines;
}
export function buildVerboseServerTimingLine(rec) {
  const stEntries = rec.server_timing || [];
  const stStr = stEntries.length > 0
    ? stEntries.map((s) => `${s.name}=${Math.round(s.duration)}ms`).join(', ')
    : '(none returned)';
  return `   ↳ server-timing: ${stStr}`;
}

// The header's own run-conditions parenthetical — device/network profile
// (only when not the desktop/no-throttle default) plus protocol, always.
// Shared between the live headline and the final summary's per-entry
// headline so the two can't drift into different field orders.
export function buildProfileParen(rec) {
  const parts = [];
  if (rec.device_profile && rec.device_profile !== 'desktop') parts.push(rec.device_profile);
  if (rec.network_profile && rec.network_profile !== 'none') parts.push(rec.network_profile);
  parts.push(rec.protocol);
  return `(${parts.join(' · ')})`;
}

// The full headline, shared verbatim between the live per-hit log and the
// final summary's notableGaps list — there's no reason for a hit's identity
// line to read differently just because it's being looked at after the fact
// instead of live. An alarm appends "── ALARM: reason" at the end of the
// SAME line (never a separate banner, never a leading tag); the summary's
// own non-alarming ("padded next-worst") entries get the same trailing
// treatment via belowThreshold, rather than a leading "[below threshold]"
// tag that would've made the two call sites diverge for no real reason.
export function buildHitHeadline(rec, { belowThreshold = false } = {}) {
  const base = `[${rec.timestamp}] ${boldize(rec.target)} ${rec.request_id} - ${rec.status} ${buildProfileParen(rec)}`;
  if (rec.alarm) return `${base}  ${alarmize(`── ALARM: ${rec.alarm_reason}`)}`;
  if (belowThreshold) return `${base}  ${dimize('(below threshold)')}`;
  return base;
}

// Full-width dim divider that closes out a live hit's block — unambiguous
// even when hits are scrolling by fast.
const HIT_RULE = '─'.repeat(66);

// A small bordered "info panel" for the startup banner — visually separates
// one-time run configuration from the scrolling per-request log lines below
// it. Left-bordered only (no fixed right edge): a fixed-width box that must
// align on both sides breaks the moment a value is longer than expected
// (e.g. a full User-Agent string) — terminals wrap long lines fine on their
// own, so there's nothing to gain by fighting that.
export const BOX_WIDTH = 78;
export function boxTop(title) {
  const dashes = '─'.repeat(Math.max(2, BOX_WIDTH - title.length - 4));
  console.log(`┌─ ${boldize(title)} ${dashes}`);
}
export function boxLine(label, value) {
  console.log(`│ ${label.padEnd(11)} ${value}`);
}
export function boxBottom() {
  console.log(`└${'─'.repeat(BOX_WIDTH - 1)}`);
}

// A minimal table renderer for the final summary: bold header row, a dashed
// rule under it, then rows padded to each column's own max content width
// (computed from the raw, unstyled text — same reasoning as boxTop's dash
// count — so styling never throws off alignment). `aligns` is 'l' or 'r' per
// column; numeric columns should be right-aligned so digits line up for
// magnitude comparison, text columns left-aligned to read as words.
export function renderTable(headers, rows, aligns, { headerStyle = boldize, rowStyle = (s) => s } = {}) {
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

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function logRequest(r, csvPath, jsonlPath, metricLabel, serverTimingMetric, verbose = false) {
  const csvLine = [
    r.timestamp, r.request_id, r.target, csvEscape(r.url), r.network_profile, r.device_profile, r.status,
    r.ttfb_ms, r.server_ms, r.gap_ms, r.gap_ratio, r.alarm ? 1 : 0, csvEscape(r.alarm_reason),
    r.wait_ms, r.dns_ms, r.connect_ms, r.tls_ms,
    r.download_ms, r.total_ms, r.redirect_ms, r.protocol,
    csvEscape(r.page_title), csvEscape(r.error), csvEscape(r.final_url),
  ].map((v) => (v === null || v === undefined ? '' : v)).join(',');
  fs.appendFileSync(csvPath, csvLine + '\n');
  fs.appendFileSync(jsonlPath, JSON.stringify(r) + '\n');

  if (r.error) {
    console.log(`[${r.timestamp}] ${boldize(r.target)} ${r.request_id} - ERROR: ${r.error}`);
    if (verbose) console.log(dimize(r.url));
    console.log(dimize(HIT_RULE));
    return;
  }

  // Headline (buildHitHeadline): time, target, id, status, and the
  // device/network/protocol parenthetical, plus an alarm tag appended at the
  // end when the hit alarms.
  //
  // Below it: --verbose's url/redirected (buildVerboseIdentityLines) and the
  // page title, all dimmed and flush left — "where/what this was," read
  // top-to-bottom as one group, immediately followed by the metrics that
  // actually matter (buildMetricsLine — shared with the final summary's
  // notableGaps list so both look identical), the DNS/connect/TLS/wait/
  // download breakdown (buildBreakdownLine), and finally --verbose's
  // server-timing line — all three full brightness (alarmized instead, like
  // metrics/breakdown, when the hit alarms), since only the identity block
  // above (url/redirected/title) is secondary enough to dim on its own.
  const identityLines = verbose ? buildVerboseIdentityLines(r) : [];
  const titleLine = `"${r.page_title}"`;
  const metrics = buildMetricsLine(r, metricLabel, serverTimingMetric);
  const breakdown = buildBreakdownLine(r);
  const serverTimingLine = verbose ? buildVerboseServerTimingLine(r) : null;

  console.log(buildHitHeadline(r));
  identityLines.forEach((line) => console.log(dimize(line)));
  console.log(dimize(titleLine));
  if (r.alarm) {
    console.log(alarmize(metrics));
    console.log(alarmize(breakdown));
  } else {
    console.log(metrics);
    console.log(breakdown);
  }
  // Full brightness, same as breakdown — only dimmed by way of alarmize
  // turning red when the hit alarms, never dimmed on its own.
  if (serverTimingLine) console.log(r.alarm ? alarmize(serverTimingLine) : serverTimingLine);
  console.log(dimize(HIT_RULE));
}

export function printRunningAggregate(results, metricLabel) {
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
    `${boldDim(metricLabel)}${dimize(` avg=${fmtMs(server.avg)} p75=${fmtMs(server.p75)}`)}  ` +
    `${boldDim('gap')}${dimize(` avg=${fmtMs(gap.avg)} p75=${fmtMs(gap.p75)}`)}`
  );
}

export function printFinalSummary(summary, metricLabel, serverTimingMetric, verbose = false) {
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
    ['Target', 'n', 'err', 'alarms', 'TTFB avg', 'TTFB p75', `${metricLabel} avg`, `${metricLabel} p75`, 'Gap avg', 'Gap p75'],
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
  // DNS/connect/TLS/wait sum to TTFB for a target that never redirects;
  // download is what follows TTFB, and redirect (when non-zero) is time TTFB
  // includes but none of the other columns account for — see buildBreakdownLine.
  const breakdownRows = targetNames
    .filter((name) => summary.byTarget[name].count > 0)
    .map((name) => {
      const s = summary.byTarget[name];
      // A `*` marks a target with at least one hidden (cross-origin) redirect
      // among its hits — those report redirect_ms=0 same as a hit that never
      // redirected at all, so this average may be an undercount for them.
      const redirectAvg = fmtMs(s.redirect_ms.avg) + (s.hiddenRedirectCount > 0 ? '*' : '');
      return [name, fmtMs(s.dns_ms.avg), fmtMs(s.connect_ms.avg), fmtMs(s.tls_ms.avg), fmtMs(s.wait_ms.avg), fmtMs(s.download_ms.avg), redirectAvg];
    });
  if (breakdownRows.length > 0) {
    renderTable(
      ['Target', 'DNS avg', 'Connect avg', 'TLS avg', 'Wait avg', 'Download avg', 'Redirect avg'],
      breakdownRows,
      ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
      { headerStyle: boldDim, rowStyle: dimize }
    );
    if (targetNames.some((name) => summary.byTarget[name].hiddenRedirectCount > 0)) {
      console.log(dimize('(* at least one hit\'s redirect time was hidden by the browser — cross-origin redirect without Timing-Allow-Origin; Redirect avg may be an undercount)'));
    }
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
      title = `All ${alarmCount} alarming gaps (TTFB − ${metricLabel}), worst first`;
    } else {
      title = `${alarmCount} alarming gap${alarmCount === 1 ? '' : 's'} + ${summary.notableGaps.length - alarmCount} next-worst (TTFB − ${metricLabel}), worst first within each`;
    }
    // Underlined with a dash rule (matching renderTable's own header/rule
    // convention above) so this title stands out from a live hit's own
    // headline — a long run of alarms can otherwise look identical enough
    // to the scrolling live log to read as "still running" rather than "this
    // is the summary."
    console.log(boldize(title));
    console.log('─'.repeat(title.length));
    if (caveat) console.log(`(${caveat})`);
    // Same HIT_RULE + blank line as the live per-hit log closes out with —
    // without the rule, a run with several alarms reads as one unbroken wall
    // of text with no visual break between where one hit's facts end and the
    // next one's begin; the blank line on top of that gives entries the same
    // breathing room a live hit gets from its own Σ line before the next one.
    //
    // Each entry is also prefixed with its rank (#1, #2, ...) — real
    // information, not decoration, since the title above already says "worst
    // first": a live hit never carries a rank number, so seeing one is proof
    // you're inside this bounded list rather than still watching live output,
    // even scrolled past the title with no banner in view.
    summary.notableGaps.forEach((g, i) => {
      console.log(`${boldize(`#${i + 1}`)} ${buildHitHeadline(g, { belowThreshold: !g.alarm })}`);
      if (verbose) buildVerboseIdentityLines(g).forEach((line) => console.log(dimize(line)));
      console.log(dimize(`"${g.page_title}"`));
      console.log(g.alarm ? alarmize(buildMetricsLine(g, metricLabel, serverTimingMetric)) : buildMetricsLine(g, metricLabel, serverTimingMetric));
      console.log(g.alarm ? alarmize(buildBreakdownLine(g)) : buildBreakdownLine(g));
      if (verbose) {
        const stLine = buildVerboseServerTimingLine(g);
        console.log(g.alarm ? alarmize(stLine) : stLine);
      }
      console.log(dimize(HIT_RULE));
      console.log('');
    });
  }
}
