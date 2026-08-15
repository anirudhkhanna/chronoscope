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
    ? `   ttfb :: ${ttfbVal}  ${metricLabel} :: ${serverVal} | gap :: ${gapVal}${gapRatioSuffix}`
    : `   ttfb :: ${boldize(ttfbVal)}  ${metricLabel} :: ${boldize(serverVal)} | gap :: ${boldize(gapVal)}${gapRatioSuffix}`;
}
export function buildBreakdownLine(rec) {
  return `   ↳ dns=${fmtMs(rec.dns_ms)} connect=${fmtMs(rec.connect_ms)} tls=${fmtMs(rec.tls_ms)} ` +
    `wait=${fmtMs(rec.wait_ms)} download=${fmtMs(rec.download_ms)}`;
}

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

export function logRequest(r, csvPath, jsonlPath, metricLabel, serverTimingMetric) {
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
  const metrics = buildMetricsLine(r, metricLabel, serverTimingMetric);
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

export function printFinalSummary(summary, metricLabel, serverTimingMetric) {
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
      title = `All ${alarmCount} alarming gaps (TTFB − ${metricLabel}), worst first`;
    } else {
      title = `${alarmCount} alarming gap${alarmCount === 1 ? '' : 's'} + ${summary.notableGaps.length - alarmCount} next-worst (TTFB − ${metricLabel}), worst first within each`;
    }
    console.log(boldize(title));
    if (caveat) console.log(`(${caveat})`);
    for (const g of summary.notableGaps) {
      const tag = g.alarm ? `[ALARM: ${g.alarm_reason}]` : '[below threshold]';
      const headline = `${tag} [${g.timestamp}] ${g.target} id=${g.request_id}`;
      console.log(headline);
      console.log(g.alarm ? alarmize(buildMetricsLine(g, metricLabel, serverTimingMetric)) : buildMetricsLine(g, metricLabel, serverTimingMetric));
      console.log(g.alarm ? alarmize(buildBreakdownLine(g)) : buildBreakdownLine(g));
    }
    console.log('');
  }
}
