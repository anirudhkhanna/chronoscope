import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server.mjs';
import { writeTempConfig, removeFile, spawnTool, sleep, snapshotLogFiles, cleanupNewLogFiles } from './helpers.mjs';

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

test('--headed: runs headed, no pausing, proceeds automatically', async () => {
  const p = writeTempConfig({ testUrls: { home: `${testServer.baseUrl}/` } });
  const tool = spawnTool(['--config=' + p, '--only=home', '--headed', '--interval=0.2', '--jitter=0']);
  try {
    await tool.waitForOutput(/headless=false/, 5000);
    // Two hits without any manual intervention proves it isn't pausing.
    await tool.waitForOutput(/Σ n=2/, 6000);
    tool.stop('SIGINT');
    const { code } = await tool.waitForExit();
    assert.equal(code, 0);
  } finally {
    tool.stop('SIGKILL');
    removeFile(p);
  }
});

test('--manual: pauses after every hit; SIGINT still shuts it down cleanly mid-pause', async () => {
  const p = writeTempConfig({ testUrls: { home: `${testServer.baseUrl}/` } });
  const tool = spawnTool(['--config=' + p, '--only=home', '--manual']);
  try {
    await tool.waitForOutput(/Chrome is open for "home" — close the window/, 8000);
    // Only one hit should have happened — the pause blocks the next one.
    assert.equal((tool.stdout.match(/Σ n=/g) || []).length, 1);
    tool.stop('SIGINT');
    const { code } = await tool.waitForExit();
    assert.equal(code, 0);
    assert.match(tool.stdout, /Stopping — writing final summary/);
  } finally {
    tool.stop('SIGKILL');
    removeFile(p);
  }
});

test('--devtools: implies --manual (pauses after every hit, same as plain --manual)', async () => {
  const p = writeTempConfig({ testUrls: { home: `${testServer.baseUrl}/` } });
  const tool = spawnTool(['--config=' + p, '--only=home', '--devtools']);
  try {
    await tool.waitForOutput(/Chrome is open for "home" — close the window/, 8000);
    assert.match(tool.stdout, /DevTools auto-opens/);
    tool.stop('SIGINT');
    const { code } = await tool.waitForExit();
    assert.equal(code, 0);
  } finally {
    tool.stop('SIGKILL');
    removeFile(p);
  }
});

test('--pause-on-alarm: pauses on a hit that actually trips an alarm', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 1,
    alarmGapRatio: 1.01, // guaranteed to trip on hit 1
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=10&delayMs=50` },
  });
  const tool = spawnTool(['--config=' + p, '--only=home', '--pause-on-alarm', '--interval=0.2', '--jitter=0']);
  try {
    await tool.waitForOutput(/Chrome is open for "home"/, 8000);
    assert.match(tool.stdout, /ALARM/);
    tool.stop('SIGINT');
    const { code } = await tool.waitForExit();
    assert.equal(code, 0);
  } finally {
    tool.stop('SIGKILL');
    removeFile(p);
  }
});

test('--pause-on-alarm: a run with no alarms at all never pauses', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 100000,
    alarmGapRatio: 100000,
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=10` },
  });
  const tool = spawnTool(['--config=' + p, '--only=home', '--pause-on-alarm', '--interval=0.2', '--jitter=0']);
  try {
    await tool.waitForOutput(/Σ n=2/, 8000);
    assert.doesNotMatch(tool.stdout, /Chrome is open for/);
    tool.stop('SIGINT');
    const { code } = await tool.waitForExit();
    assert.equal(code, 0);
  } finally {
    tool.stop('SIGKILL');
    removeFile(p);
  }
});
