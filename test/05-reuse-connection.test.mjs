import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server.mjs';
import { writeTempConfig, removeFile, runForHits, runForHitsAndGetFiles, parseCsv, spawnTool, snapshotLogFiles, cleanupNewLogFiles } from './helpers.mjs';
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

test('reuse-connection: without the flag, each hit opens its own fresh TCP connection', async () => {
  const p = writeTempConfig({ testUrls: { home: `${testServer.baseUrl}/` } });
  try {
    testServer.resetConnectionCount();
    await runForHits(['--config=' + p, '--only=home', '--interval=0'], 3);
    assert.equal(testServer.getConnectionCount(), 3, 'expected a fresh connection per hit');
  } finally {
    removeFile(p);
  }
});

test('reuse-connection: with the flag, repeated hits to one target reuse a single TCP connection', async () => {
  const p = writeTempConfig({ testUrls: { home: `${testServer.baseUrl}/` } });
  try {
    testServer.resetConnectionCount();
    await runForHits(['--config=' + p, '--only=home', '--reuse-connection', '--interval=0'], 4);
    assert.equal(testServer.getConnectionCount(), 1, 'expected exactly one connection reused across all hits');
  } finally {
    removeFile(p);
  }
});

test('reuse-connection: works with multiple targets, each getting its own independently-reused connection', async () => {
  const p = writeTempConfig({
    testUrls: {
      a: `${testServer.baseUrl}/?t=a`,
      b: `${testServer.baseUrl}/?t=b`,
    },
  });
  try {
    testServer.resetConnectionCount();
    // 2 targets x 3 rounds = 6 hits total, but only 2 distinct connections
    // (one per target) if per-target reuse is actually working.
    await runForHits(['--config=' + p, '--only=a,b', '--reuse-connection', '--interval=0'], 6);
    assert.equal(testServer.getConnectionCount(), 2, 'expected exactly one connection per target, reused across rounds');
  } finally {
    removeFile(p);
  }
});

test('reuse-connection: Empty-Cache-and-Hard-Reload CDP calls do not error across repeated hits', async () => {
  const p = writeTempConfig({ testUrls: { home: `${testServer.baseUrl}/` } });
  try {
    const { code, csvFiles } = await runForHitsAndGetFiles(['--config=' + p, '--only=home', '--reuse-connection', '--interval=0'], 3);
    assert.equal(code, 0);
    const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
    // --interval=0 against a fast local reused connection can fire more than
    // the N hits we waited for before SIGINT actually lands, and whichever
    // hit was in flight right when the signal arrives is expected to abort
    // (ERR_ABORTED) — that's normal shutdown behavior, not a bug. Only the
    // hits that had a chance to fully complete need to be error-free.
    assert.ok(rows.length >= 3, `expected at least 3 rows, got ${rows.length}`);
    const completed = rows.slice(0, 3);
    assert.ok(completed.every((r) => r.status === '200' && r.error === ''));
  } finally {
    removeFile(p);
  }
});

test('reuse-connection: requires no target-count restriction anymore (regression check)', async () => {
  // This used to be rejected outright ("requires exactly one target") before
  // the per-target persistentByTarget Map was introduced — asserting it's
  // accepted guards against that restriction quietly coming back.
  const p = writeTempConfig({
    testUrls: { a: `${testServer.baseUrl}/?t=a`, b: `${testServer.baseUrl}/?t=b`, c: `${testServer.baseUrl}/?t=c` },
  });
  try {
    const { code } = await runForHits(['--config=' + p, '--reuse-connection', '--interval=0'], 3);
    assert.equal(code, 0);
  } finally {
    removeFile(p);
  }
});

test('reuse-connection + --manual: pauses on every hit via a terminal keypress, not a window close, and reuses the connection across the pause', async () => {
  const p = writeTempConfig({ testUrls: { home: `${testServer.baseUrl}/` } });
  const tool = spawnTool(['--config=' + p, '--only=home', '--reuse-connection', '--manual', '--interval=0']);
  try {
    testServer.resetConnectionCount();
    await tool.waitForOutput(/Hit for "home" — Chrome is still open on the same page/, 8000);
    assert.doesNotMatch(tool.stdout, /close the window/);
    tool.sendInput('\n');
    await tool.waitForOutput(/Σ n=2/, 8000);
    assert.equal(testServer.getConnectionCount(), 1, 'connection should still be reused across the pause/resume');
    tool.stop('SIGINT');
    const { code } = await tool.waitForExit();
    assert.equal(code, 0);
  } finally {
    tool.stop('SIGKILL');
    removeFile(p);
  }
});

test('reuse-connection + --pause-on-alarm: only pauses on the alarming hit, via keypress', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 1,
    alarmGapRatio: 1.01,
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=10&delayMs=50` },
  });
  const tool = spawnTool(['--config=' + p, '--only=home', '--reuse-connection', '--pause-on-alarm', '--interval=0']);
  try {
    await tool.waitForOutput(/ALARM on "home" — Chrome is still open on the same page/, 8000);
    tool.stop('SIGINT');
    const { code } = await tool.waitForExit();
    assert.equal(code, 0);
  } finally {
    tool.stop('SIGKILL');
    removeFile(p);
  }
});
