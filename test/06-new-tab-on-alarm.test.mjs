import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server.mjs';
import { writeTempConfig, removeFile, spawnTool, sleep, snapshotLogFiles, cleanupNewLogFiles } from './helpers.mjs';

let testServer;
let configPath;
let logsBefore;

before(async () => {
  testServer = await startTestServer();
  // Every hit alarms — makes the tab-accumulation behavior deterministic.
  configPath = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 1,
    alarmGapRatio: 0.01,
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=10&delayMs=50` },
  });
  logsBefore = snapshotLogFiles();
});

after(async () => {
  await testServer.stop();
  removeFile(configPath);
  cleanupNewLogFiles(logsBefore);
});

test('new-tab-on-alarm: accumulates one kept-open tab per alarm, unattended (no pause)', async () => {
  const tool = spawnTool(['--config=' + configPath, '--only=home', '--reuse-connection', '--new-tab-on-alarm', '--headed', '--interval=0.2', '--jitter=0']);
  try {
    await tool.waitForOutput('(2 tabs kept open so far)', 8000);
    tool.stop('SIGINT');
    await sleep(200);
    tool.stop('SIGINT'); // second Ctrl+C: exit for real (first would just pause)
    const { code } = await tool.waitForExit();
    assert.equal(code, 0);
  } finally {
    tool.stop('SIGKILL');
  }
});

test('new-tab-on-alarm: --devtools does NOT force a pause here (regression check)', async () => {
  // Without the newTabOnAlarm carve-out, plain --devtools would force
  // shouldPause true on every single hit, defeating the whole point of
  // running unattended. Assert at least 2 hits complete with zero manual
  // intervention (no keypress, no extra Ctrl+C) before we stop it ourselves.
  const tool = spawnTool(['--config=' + configPath, '--only=home', '--reuse-connection', '--new-tab-on-alarm', '--devtools', '--interval=0.2', '--jitter=0']);
  try {
    await tool.waitForOutput('(2 tabs kept open so far)', 8000);
    assert.doesNotMatch(tool.stdout, /Press Enter here to resume/);
    tool.stop('SIGINT');
    await sleep(200);
    tool.stop('SIGINT');
    await tool.waitForExit();
  } finally {
    tool.stop('SIGKILL');
  }
});

test('new-tab-on-alarm: first Ctrl+C pauses (process stays alive, Chrome untouched)', async () => {
  const tool = spawnTool(['--config=' + configPath, '--only=home', '--reuse-connection', '--new-tab-on-alarm', '--headed', '--interval=0.2', '--jitter=0']);
  try {
    await tool.waitForOutput('(1 tab kept open so far)', 8000);
    tool.stop('SIGINT');
    await tool.waitForOutput(/Paused — Chrome and every kept-open tab remain exactly as they are/, 3000);
    await sleep(500);
    assert.equal(tool.proc.exitCode, null, 'process should still be alive while paused');
    // SIGKILL (in `finally` below) can't cascade to the child Chrome process
    // it left running while paused — a second Ctrl+C here triggers a real,
    // graceful finalizeAndExit (with its own browser.close()) instead.
    tool.stop('SIGINT');
    await tool.waitForExit();
  } finally {
    tool.stop('SIGKILL');
  }
});

test('new-tab-on-alarm: resume keypress continues reloading, then a second Ctrl+C while running pauses again, and a third (while paused) exits for good', async () => {
  const tool = spawnTool(['--config=' + configPath, '--only=home', '--reuse-connection', '--new-tab-on-alarm', '--headed', '--interval=0.2', '--jitter=0']);
  try {
    await tool.waitForOutput('(1 tab kept open so far)', 8000);
    tool.stop('SIGINT');
    await tool.waitForOutput(/Paused —/, 3000);

    tool.sendInput('\n');
    await tool.waitForOutput('Resuming...', 3000);
    await tool.waitForOutput('(2 tabs kept open so far)', 8000);

    tool.stop('SIGINT');
    await tool.waitForOutput(/Paused —/, 3000);
    assert.equal(tool.proc.exitCode, null, 'still alive after the second (pausing) Ctrl+C');

    // Standard POSIX signals aren't queued — firing SIGINT again the instant
    // after the prior one merely confirmed "Paused —" printed risks the
    // second delivery coalescing with a not-yet-fully-processed first one
    // under CI's heavier scheduling jitter (never reproduced locally, but hit
    // 04-network-device.test.mjs's equivalent double-SIGINT-to-exit sequence
    // already uses this same gap). A short real gap makes the two signals
    // unambiguously distinct deliveries.
    await sleep(200);
    tool.stop('SIGINT'); // third: already paused, so this one exits for real
    const { code } = await tool.waitForExit();
    assert.equal(code, 0);
  } finally {
    tool.stop('SIGKILL');
  }
});
