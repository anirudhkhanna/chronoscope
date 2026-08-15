import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server.mjs';
import { writeTempConfig, removeFile, runForHitsAndGetFiles, parseCsv, snapshotLogFiles, cleanupNewLogFiles } from './helpers.mjs';
import fs from 'fs';

// Several assertions below check the relative ORDER of things across a style
// boundary (e.g. the bold target name followed by plain metadata) — the ANSI
// reset code sitting between them breaks a naive adjacency regex, so those
// checks strip styling first and match on the plain text instead.
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

let testServer;
let configPath;
let logsBefore;

before(async () => {
  testServer = await startTestServer();
  configPath = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=10&serverTimingName=origin-rtt` },
  });
  logsBefore = snapshotLogFiles();
});

after(async () => {
  await testServer.stop();
  removeFile(configPath);
  cleanupNewLogFiles(logsBefore);
});

test('default (no --verbose): the console log does not print the hit URL', async () => {
  const { tool } = await runForHitsAndGetFiles(['--config=' + configPath, '--interval=0'], 1);
  assert.doesNotMatch(tool.stdout, /https?:\/\/127\.0\.0\.1/);
  assert.doesNotMatch(tool.stdout, /server-timing:/);
});

test('--verbose: prints the exact URL hit, including the injected id, bare on its own line (no label)', async () => {
  const { tool, csvFiles } = await runForHitsAndGetFiles(['--config=' + configPath, '--verbose', '--interval=0'], 1);
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  const hitUrl = rows[0].url;
  assert.match(tool.stdout, new RegExp(hitUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(tool.stdout, /↳ url:/);
});

test('--verbose: prints the full raw Server-Timing response', async () => {
  const { tool } = await runForHitsAndGetFiles(['--config=' + configPath, '--verbose', '--interval=0'], 1);
  assert.match(tool.stdout, /↳ server-timing: origin-rtt=10ms/);
});

test('--verbose: a target with no Server-Timing header at all shows "(none returned)"', async () => {
  const p = writeTempConfig({ testUrls: { home: `${testServer.baseUrl}/` } });
  try {
    const { tool } = await runForHitsAndGetFiles(['--config=' + p, '--verbose', '--interval=0'], 1);
    assert.match(tool.stdout, /↳ server-timing: \(none returned\)/);
  } finally {
    removeFile(p);
  }
});

test('--verbose: a redirecting target prints where navigation actually landed', async () => {
  const p = writeTempConfig({
    testUrls: { home: `${testServer.baseUrl}/?redirectTo=${encodeURIComponent(testServer.baseUrl + '/landed')}` },
  });
  try {
    const { tool, csvFiles } = await runForHitsAndGetFiles(['--config=' + p, '--verbose', '--interval=0'], 1);
    assert.match(tool.stdout, new RegExp(`↳ redirected → ${testServer.baseUrl}/landed`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
    assert.equal(rows[0].final_url, `${testServer.baseUrl}/landed`);
  } finally {
    removeFile(p);
  }
});

test('no redirect: --verbose does not print a "redirected" line, and final_url in the CSV matches the requested url', async () => {
  const { tool, csvFiles } = await runForHitsAndGetFiles(['--config=' + configPath, '--verbose', '--interval=0'], 1);
  assert.doesNotMatch(tool.stdout, /redirected →/);
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  assert.equal(rows[0].final_url, rows[0].url);
});

test('a redirecting hit shows redirect=Xms on the breakdown line, even without --verbose — TTFB silently includes it otherwise', async () => {
  const p = writeTempConfig({
    testUrls: { home: `${testServer.baseUrl}/?redirectTo=${encodeURIComponent(testServer.baseUrl + '/landed')}` },
  });
  try {
    const { tool } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 1);
    assert.match(tool.stdout, /↳ redirect=\d+ms dns=/);
  } finally {
    removeFile(p);
  }
});

test('a non-redirecting hit omits redirect= entirely from the breakdown line', async () => {
  const { tool } = await runForHitsAndGetFiles(['--config=' + configPath, '--interval=0'], 1);
  assert.doesNotMatch(tool.stdout, /redirect=/);
  assert.match(tool.stdout, /↳ dns=/);
});

test('a cross-origin redirect (no Timing-Allow-Origin) shows "redirect=hidden (cross-origin)", not a misleading 0ms', async () => {
  const otherOriginServer = await startTestServer();
  const p = writeTempConfig({
    testUrls: { home: `${testServer.baseUrl}/?redirectTo=${encodeURIComponent(otherOriginServer.baseUrl + '/landed')}` },
  });
  try {
    const { tool, csvFiles } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 1);
    // Real Chrome behavior, not our own choice: redirectStart/redirectEnd
    // read 0 for a cross-origin redirect without Timing-Allow-Origin, even
    // though final_url proves a redirect genuinely happened.
    assert.match(tool.stdout, /↳ redirect=hidden \(cross-origin\) dns=/);
    const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
    assert.equal(rows[0].final_url, `${otherOriginServer.baseUrl}/landed`);
  } finally {
    removeFile(p);
    await otherOriginServer.stop();
  }
});

test('a target with a hidden (cross-origin) redirect gets a "*" on its Redirect avg and a disclaimer under the table', async () => {
  const otherOriginServer = await startTestServer();
  const p = writeTempConfig({
    testUrls: { home: `${testServer.baseUrl}/?redirectTo=${encodeURIComponent(otherOriginServer.baseUrl + '/landed')}` },
  });
  try {
    const { tool } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 1);
    const plain = stripAnsi(tool.stdout);
    assert.match(plain, /home\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+0ms\*/);
    assert.match(plain, /\(\* at least one hit's redirect time was hidden by the browser/);
  } finally {
    removeFile(p);
    await otherOriginServer.stop();
  }
});

test('no disclaimer appears when no target had a hidden redirect', async () => {
  const { tool } = await runForHitsAndGetFiles(['--config=' + configPath, '--interval=0'], 1);
  assert.doesNotMatch(tool.stdout, /redirect time was hidden/);
});

test('the final summary\'s DNS/connect/TLS/wait table also reports Download avg and Redirect avg per target', async () => {
  const p = writeTempConfig({
    testUrls: {
      home: `${testServer.baseUrl}/?redirectTo=${encodeURIComponent(testServer.baseUrl + '/landed')}`,
      other: `${testServer.baseUrl}/`,
    },
  });
  try {
    const { tool } = await runForHitsAndGetFiles(['--config=' + p, '--only=all', '--interval=0'], 2);
    const plain = stripAnsi(tool.stdout);
    assert.match(plain, /Target\s+DNS avg\s+Connect avg\s+TLS avg\s+Wait avg\s+Download avg\s+Redirect avg/);
    // home redirected (non-zero Redirect avg), other didn't (0ms) — same table, both rows present.
    assert.match(plain, /home\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(?!0ms)\d+ms/);
    assert.match(plain, /other\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+0ms/);
  } finally {
    removeFile(p);
  }
});

test('default headline format: [time] target id - status (proto), then the page title on its own line', async () => {
  const { tool } = await runForHitsAndGetFiles(['--config=' + configPath, '--interval=0'], 1);
  const plain = stripAnsi(tool.stdout);
  assert.match(plain, /\[\d{4}-\d{2}-\d{2}T[^\]]+\] home \S+ - 200 \(\S+\)\n"chronoscope-test"/);
});

test('--verbose headline format: url sits between the headline and the page title', async () => {
  const { tool } = await runForHitsAndGetFiles(['--config=' + configPath, '--verbose', '--interval=0'], 1);
  const plain = stripAnsi(tool.stdout);
  assert.match(plain, /home \S+ - 200 \(\S+\)\nhttp\S+\n"chronoscope-test"/);
});

test('device + network profile: both appear in the header parenthetical, ahead of the protocol', async () => {
  const p = writeTempConfig({ testUrls: { home: `${testServer.baseUrl}/` } });
  try {
    const { tool } = await runForHitsAndGetFiles(['--config=' + p, '--mobile', '--network=slow-3g', '--interval=0'], 1);
    const plain = stripAnsi(tool.stdout);
    assert.match(plain, /home \S+ - 200 \(pixel · slow-3g · \S+\)/);
  } finally {
    removeFile(p);
  }
});

test('an alarming hit appends "-- ALARM: <reason>" to the headline instead of a separate banner line', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 1,
    alarmGapRatio: 0.01,
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=5&serverTimingName=origin-rtt&delayMs=20` },
  });
  try {
    const { tool } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 1);
    const plain = stripAnsi(tool.stdout);
    assert.match(plain, /home \S+ - 200 \(\S+\)  ── ALARM: \S+/);
    assert.doesNotMatch(plain, /!! ALARM/);
  } finally {
    removeFile(p);
  }
});

test('--verbose: the final summary\'s notableGaps entries use the exact same headline shape as the live line — no leading tag, alarm suffix at the end', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 1,
    alarmGapRatio: 0.01, // guarantee an alarm so notableGaps is non-empty
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=5&serverTimingName=origin-rtt&delayMs=20` },
  });
  try {
    const { tool } = await runForHitsAndGetFiles(['--config=' + p, '--verbose', '--interval=0'], 1);
    const plain = stripAnsi(tool.stdout);
    assert.doesNotMatch(plain, /\[ALARM:/); // no more leading bracket tag
    assert.match(plain, /\[\d{4}-\d{2}-\d{2}T[^\]]+\] home \S+ - 200 \(\S+\)  ── ALARM: \S+\nhttp\S+\n"chronoscope-test"/);
    assert.match(plain, /↳ server-timing: origin-rtt=5ms/);
  } finally {
    removeFile(p);
  }
});

test('--verbose: the final summary closes each notableGaps entry with the same rule divider as a live hit, then a blank line', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 1,
    alarmGapRatio: 0.01,
    testUrls: {
      home: `${testServer.baseUrl}/?serverTimingMs=5&serverTimingName=origin-rtt&delayMs=20`,
      other: `${testServer.baseUrl}/?serverTimingMs=5&serverTimingName=origin-rtt&delayMs=30`,
    },
  });
  try {
    const { tool } = await runForHitsAndGetFiles(['--config=' + p, '--only=all', '--verbose', '--interval=0'], 2);
    // Both entries' server-timing lines exist, each followed by a dim rule
    // and then a blank line before the next entry's headline — not running
    // straight into the next entry with nothing to divide them.
    assert.match(stripAnsi(tool.stdout), /↳ server-timing: origin-rtt=5ms\n─+\n\n#\d+ \[\d{4}-\d{2}-\d{2}T/);
  } finally {
    removeFile(p);
  }
});

test('without --verbose: the final summary\'s notableGaps entries still show the header/title, but no url or server-timing', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 1,
    alarmGapRatio: 0.01,
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=5&serverTimingName=origin-rtt&delayMs=20` },
  });
  try {
    const { tool } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 1);
    const plain = stripAnsi(tool.stdout);
    assert.match(plain, /\[\d{4}-\d{2}-\d{2}T[^\]]+\] home \S+ - 200 \(\S+\)  ── ALARM: \S+\n"chronoscope-test"/);
    assert.doesNotMatch(plain, /server-timing:/);
  } finally {
    removeFile(p);
  }
});

test('the final summary numbers each notableGaps entry by rank (#1, #2, ...), worst first', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 1,
    alarmGapRatio: 0.01,
    testUrls: {
      home: `${testServer.baseUrl}/?serverTimingMs=5&serverTimingName=origin-rtt&delayMs=20`,
      other: `${testServer.baseUrl}/?serverTimingMs=5&serverTimingName=origin-rtt&delayMs=30`,
    },
  });
  try {
    const { tool } = await runForHitsAndGetFiles(['--config=' + p, '--only=all', '--interval=0'], 2);
    const plain = stripAnsi(tool.stdout);
    // "other" (delayMs=30, the bigger gap) should rank #1, "home" #2 — the
    // section title itself says "worst first", so the numbering must match.
    assert.match(plain, /#1 \[\d{4}-\d{2}-\d{2}T[^\]]+\] other /);
    assert.match(plain, /#2 \[\d{4}-\d{2}-\d{2}T[^\]]+\] home /);
  } finally {
    removeFile(p);
  }
});

test('the "worst first" section title is underlined with a dash rule matching its own length, distinct from a live headline', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 1,
    alarmGapRatio: 0.01,
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=5&serverTimingName=origin-rtt&delayMs=20` },
  });
  try {
    const { tool } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 1);
    const title = 'All 1 alarming gaps (TTFB − origin-rtt), worst first';
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(tool.stdout, new RegExp(`${escapedTitle}\\x1b\\[0m\\n${'─'.repeat(title.length)}\\n`));
  } finally {
    removeFile(p);
  }
});

test('a padded non-alarming entry in the summary gets "(below threshold)" at the end of its headline, not a leading tag', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 100000, // effectively never alarms
    alarmGapRatio: 100000,
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=5&serverTimingName=origin-rtt&delayMs=10` },
  });
  try {
    const { tool } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 1);
    const plain = stripAnsi(tool.stdout);
    assert.doesNotMatch(plain, /\[below threshold\]/);
    assert.match(plain, /\[\d{4}-\d{2}-\d{2}T[^\]]+\] home \S+ - 200 \(\S+\)  \(below threshold\)/);
  } finally {
    removeFile(p);
  }
});
