import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server.mjs';
import { writeTempConfig, removeFile, runForHits, runForHitsAndGetFiles, parseCsv, parseJsonl, snapshotLogFiles, cleanupNewLogFiles } from './helpers.mjs';
import fs from 'fs';

let testServer;
let logsBefore;

before(async () => {
  testServer = await startTestServer();
  logsBefore = snapshotLogFiles();
});

after(async () => {
  await testServer.stop();
  cleanupNewLogFiles(logsBefore);
});

test('alarm: a hit with no meaningful gap does not alarm', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 500,
    alarmGapRatio: 2.5,
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=100` },
  });
  try {
    const { csvFiles } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 1);
    const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
    assert.equal(rows[0].alarm, '0');
    assert.equal(rows[0].alarm_reason, '');
  } finally {
    removeFile(p);
  }
});

test('alarm: gap-only alarm reason when only the absolute-ms threshold trips', async () => {
  // server reports 400ms, ttfb ~= 400 + delay(700) => gap ~700ms >= 500ms
  // threshold, but ratio ~= (400+700)/400 = 2.75x is ALSO above 2.5x... to
  // isolate a pure "gap" reason we need a case where ratio stays low but the
  // absolute gap is large: a big server_ms with a moderate added delay.
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 500,
    alarmGapRatio: 10, // deliberately unreachable, isolates the gap-only path
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=100&delayMs=700` },
  });
  try {
    const { csvFiles } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 1);
    const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
    assert.equal(rows[0].alarm, '1');
    assert.equal(rows[0].alarm_reason, 'gap');
  } finally {
    removeFile(p);
  }
});

test('alarm: ratio-only alarm reason when only the multiplier threshold trips', async () => {
  // server reports a tiny 10ms, so even a small added delay pushes the
  // ratio way past 2.5x while staying well under a very high gap-ms bar.
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 100000,
    alarmGapRatio: 2.5,
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=10&delayMs=100` },
  });
  try {
    const { csvFiles } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 1);
    const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
    assert.equal(rows[0].alarm, '1');
    assert.equal(rows[0].alarm_reason, 'ratio');
  } finally {
    removeFile(p);
  }
});

test('alarm: gap+ratio combined reason when both thresholds trip', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 200,
    alarmGapRatio: 2,
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=50&delayMs=500` },
  });
  try {
    const { csvFiles } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 1);
    const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
    assert.equal(rows[0].alarm, '1');
    assert.equal(rows[0].alarm_reason, 'gap+ratio');
  } finally {
    removeFile(p);
  }
});

test('cli: --alarm-gap/--alarm-ratio override the config defaults for this run', async () => {
  // Config sets a very lenient threshold; CLI tightens it so the same
  // response now alarms.
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 100000,
    alarmGapRatio: 100000,
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=50&delayMs=300` },
  });
  try {
    const { csvFiles } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0', '--alarm-gap=100', '--alarm-ratio=1.5'], 1);
    const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
    assert.equal(rows[0].alarm, '1');
  } finally {
    removeFile(p);
  }
});

test('only: filtering by group name hits every target in that group', async () => {
  const p = writeTempConfig({
    testUrls: {
      home: `${testServer.baseUrl}/`,
      pdp: { a: `${testServer.baseUrl}/?p=a`, b: `${testServer.baseUrl}/?p=b` },
    },
  });
  try {
    const { csvFiles } = await runForHitsAndGetFiles(['--config=' + p, '--only=pdp', '--interval=0'], 2);
    const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
    const names = rows.map((r) => r.target).sort();
    assert.deepEqual(names, ['pdp-a', 'pdp-b']);
  } finally {
    removeFile(p);
  }
});

test('only: filtering by a comma list of specific target names', async () => {
  const p = writeTempConfig({
    testUrls: {
      home: `${testServer.baseUrl}/`,
      other: `${testServer.baseUrl}/?o=1`,
      pdp: { a: `${testServer.baseUrl}/?p=a` },
    },
  });
  try {
    const { csvFiles } = await runForHitsAndGetFiles(['--config=' + p, '--only=home,pdp-a', '--interval=0'], 2);
    const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
    const names = new Set(rows.map((r) => r.target));
    assert.deepEqual(names, new Set(['home', 'pdp-a']));
  } finally {
    removeFile(p);
  }
});

test('no-js: timing is still captured correctly with JavaScript disabled', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=42` },
  });
  try {
    const { tool, csvFiles } = await runForHitsAndGetFiles(['--config=' + p, '--no-js', '--interval=0'], 1);
    assert.match(tool.stdout, /JavaScript\s+disabled/);
    const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
    assert.equal(rows[0].status, '200');
    assert.ok(Number(rows[0].ttfb_ms) > 0);
    assert.equal(rows[0].server_ms, '42');
  } finally {
    removeFile(p);
  }
});

test('output: JSONL rows include the full server_timing array', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=77&serverTimingName=origin-rtt` },
  });
  try {
    const { jsonlFiles } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 1);
    const rows = parseJsonl(fs.readFileSync(jsonlFiles[0], 'utf8'));
    assert.equal(rows.length, 1);
    assert.ok(Array.isArray(rows[0].server_timing));
    assert.deepEqual(rows[0].server_timing[0], { name: 'origin-rtt', duration: 77 });
  } finally {
    removeFile(p);
  }
});

test('output: summary.json exposes notableGaps and pads with next-worst non-alarming hits when there are fewer than 5 alarms', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 300,
    alarmGapRatio: 3,
    testUrls: {
      alarming: `${testServer.baseUrl}/?serverTimingMs=50&delayMs=500`,
      quiet1: `${testServer.baseUrl}/?serverTimingMs=50&delayMs=10`,
      quiet2: `${testServer.baseUrl}/?serverTimingMs=50&delayMs=20`,
    },
  });
  try {
    const { summaryFiles } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 3);
    const summary = JSON.parse(fs.readFileSync(summaryFiles[0], 'utf8'));
    assert.equal(summary.notableGaps.length, 3); // 1 alarm + 2 padded non-alarms
    assert.equal(summary.notableGaps.filter((g) => g.alarm).length, 1);
    assert.equal(summary.eligibleNonAlarmingCount, 2);
  } finally {
    removeFile(p);
  }
});

test('output: eligibleNonAlarmingCount is 0 and a caveat is needed when no target has Server-Timing data to pad with', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 50,
    alarmGapRatio: 1.5,
    testUrls: {
      alarming: `${testServer.baseUrl}/?serverTimingMs=10&delayMs=300`,
      noTiming: `${testServer.baseUrl}/`, // no serverTimingMs at all
    },
  });
  try {
    const { tool, summaryFiles } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 2);
    const summary = JSON.parse(fs.readFileSync(summaryFiles[0], 'utf8'));
    assert.equal(summary.eligibleNonAlarmingCount, 0);
    assert.match(tool.stdout, /No non-alarming hits with Server-Timing data available to pad with/);
  } finally {
    removeFile(p);
  }
});
