import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server.mjs';
import { writeTempConfig, removeFile, runForHitsAndGetFiles, runForHits, parseCsv, snapshotLogFiles, cleanupNewLogFiles, spawnTool, sleep } from './helpers.mjs';
import fs from 'fs';

let testServer;
let configPath;
let logsBefore;

before(async () => {
  testServer = await startTestServer();
  configPath = writeTempConfig({
    testUrls: { home: `${testServer.baseUrl}/` },
  });
  logsBefore = snapshotLogFiles();
});

after(async () => {
  await testServer.stop();
  removeFile(configPath);
  cleanupNewLogFiles(logsBefore);
});

test('network: a named preset is applied without error and recorded in the CSV', async () => {
  const { code, csvFiles } = await runForHitsAndGetFiles(['--config=' + configPath, '--network=slow-3g', '--interval=0'], 1);
  assert.equal(code, 0);
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  assert.equal(rows[0].network_profile, 'slow-3g');
  assert.equal(rows[0].status, '200');
});

test('network: a custom rtt/down/up profile is recorded as "custom"', async () => {
  const { code, csvFiles } = await runForHitsAndGetFiles(
    ['--config=' + configPath, '--network-rtt=50', '--network-down=5000', '--network-up=2000', '--interval=0'],
    1,
  );
  assert.equal(code, 0);
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  assert.equal(rows[0].network_profile, 'custom');
});

test('network: with no --network flag, the profile is recorded as "none"', async () => {
  const { csvFiles } = await runForHitsAndGetFiles(['--config=' + configPath, '--interval=0'], 1);
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  assert.equal(rows[0].network_profile, 'none');
});

test('device: --mobile defaults to the pixel profile', async () => {
  const { tool, csvFiles } = await runForHitsAndGetFiles(['--config=' + configPath, '--mobile', '--interval=0'], 1);
  assert.match(tool.stdout, /Device\s+pixel/);
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  assert.equal(rows[0].device_profile, 'pixel');
  const ua = testServer.getLastHeaders()['user-agent'];
  assert.match(ua, /Android/);
  assert.match(ua, /Mobile/);
});

test('device: --device=galaxy selects that specific device, implies mobile, and tags the UA with its real model', async () => {
  const { csvFiles } = await runForHitsAndGetFiles(['--config=' + configPath, '--device=galaxy', '--interval=0'], 1);
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  assert.equal(rows[0].device_profile, 'galaxy');
  const ua = testServer.getLastHeaders()['user-agent'];
  assert.match(ua, /Android/);
  assert.match(ua, /SM-S901B/); // galaxy's real deviceModel from MOBILE_PRESETS
});

test('device: --device=tablet selects the tablet profile and tags the UA with its real model', async () => {
  const { csvFiles } = await runForHitsAndGetFiles(['--config=' + configPath, '--device=tablet', '--interval=0'], 1);
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  assert.equal(rows[0].device_profile, 'tablet');
  const ua = testServer.getLastHeaders()['user-agent'];
  assert.match(ua, /Android/);
  assert.match(ua, /SM-X706B/); // tablet's real deviceModel from MOBILE_PRESETS
});

test('device: with no --mobile/--device flag, the profile is recorded as "desktop"', async () => {
  const { csvFiles } = await runForHitsAndGetFiles(['--config=' + configPath, '--interval=0'], 1);
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  assert.equal(rows[0].device_profile, 'desktop');
  const ua = testServer.getLastHeaders()['user-agent'];
  assert.doesNotMatch(ua, /Android/);
});

// Device emulation (viewport/UA/touch) is a Playwright *context*-level
// setting — these tests exist because that's an assumption, not a guarantee,
// and it's cheap to actually confirm it holds across the flags most likely
// to interact with it, instead of just trusting the mental model.

test('device + reuse-connection: connection is still reused across mobile-emulated hits', async () => {
  const p = writeTempConfig({ testUrls: { home: `${testServer.baseUrl}/` } });
  try {
    testServer.resetConnectionCount();
    await runForHits(['--config=' + p, '--only=home', '--mobile', '--reuse-connection', '--interval=0'], 3);
    assert.equal(testServer.getConnectionCount(), 1, 'expected one connection reused across all mobile-emulated hits');
    const ua = testServer.getLastHeaders()['user-agent'];
    assert.match(ua, /Android/);
    assert.match(ua, /Mobile/);
  } finally {
    removeFile(p);
  }
});

test('device + reuse-connection + new-tab-on-alarm: a fresh tab opened after an alarm still carries the mobile UA', async () => {
  const p = writeTempConfig({
    serverTimingMetric: 'origin-rtt',
    alarmGapMs: 1,
    alarmGapRatio: 0.01, // every hit alarms, forcing at least one new tab
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=10&delayMs=30` },
  });
  const tool = spawnTool(['--config=' + p, '--only=home', '--mobile', '--reuse-connection', '--new-tab-on-alarm', '--headed', '--interval=0.2', '--jitter=0']);
  try {
    await tool.waitForOutput('(2 tabs kept open so far)', 8000);
    // The most recent hit landed on the second (post-alarm) tab — confirms
    // context-level device emulation isn't lost when --new-tab-on-alarm
    // opens a fresh page via context.newPage().
    const ua = testServer.getLastHeaders()['user-agent'];
    assert.match(ua, /Android/);
    assert.match(ua, /Mobile/);
    tool.stop('SIGINT');
    await sleep(200);
    tool.stop('SIGINT');
    await tool.waitForExit();
  } finally {
    tool.stop('SIGKILL');
    removeFile(p);
  }
});

test('device + --no-js: mobile emulation and disabled JavaScript coexist without error', async () => {
  const { code, tool, csvFiles } = await runForHitsAndGetFiles(['--config=' + configPath, '--mobile', '--no-js', '--interval=0'], 3);
  assert.equal(code, 0);
  assert.match(tool.stdout, /JavaScript\s+disabled/);
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  assert.ok(rows.length >= 3);
  assert.ok(rows.slice(0, 3).every((r) => r.status === '200' && r.error === ''));
  const ua = testServer.getLastHeaders()['user-agent'];
  assert.match(ua, /Android/);
});
