import { stats } from './util.mjs';
import { NOTABLE_GAPS_TARGET } from './constants.mjs';

export function buildSummary(results, runId, targets) {
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
