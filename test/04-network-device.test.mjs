import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server.mjs';
import { writeTempConfig, removeFile, runForHitsAndGetFiles, parseCsv, snapshotLogFiles, cleanupNewLogFiles } from './helpers.mjs';
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

test('device: --device=galaxy selects that specific device and implies mobile', async () => {
  const { csvFiles } = await runForHitsAndGetFiles(['--config=' + configPath, '--device=galaxy', '--interval=0'], 1);
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  assert.equal(rows[0].device_profile, 'galaxy');
});

test('device: --device=tablet selects the tablet profile', async () => {
  const { csvFiles } = await runForHitsAndGetFiles(['--config=' + configPath, '--device=tablet', '--interval=0'], 1);
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  assert.equal(rows[0].device_profile, 'tablet');
});

test('device: with no --mobile/--device flag, the profile is recorded as "desktop"', async () => {
  const { csvFiles } = await runForHitsAndGetFiles(['--config=' + configPath, '--interval=0'], 1);
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  assert.equal(rows[0].device_profile, 'desktop');
  const ua = testServer.getLastHeaders()['user-agent'];
  assert.doesNotMatch(ua, /Android/);
});
