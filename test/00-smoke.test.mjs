import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server.mjs';
import { writeTempConfig, removeFile, snapshotLogFiles, cleanupNewLogFiles, runForHits, parseCsv, readNewLogFiles } from './helpers.mjs';
import fs from 'fs';

let testServer;
let configPath;
let logsBefore;

before(async () => {
  testServer = await startTestServer();
  configPath = writeTempConfig({
    name: 'SmokeTest',
    serverTimingMetric: 'origin-rtt',
    testUrls: { home: `${testServer.baseUrl}/?serverTimingMs=10` },
  });
  logsBefore = snapshotLogFiles();
});

after(async () => {
  await testServer.stop();
  removeFile(configPath);
  cleanupNewLogFiles(logsBefore);
});

test('smoke: one hit produces a CSV row with expected fields', async () => {
  const { code } = await runForHits(['--config=' + configPath, '--interval=0'], 1);
  assert.equal(code, 0);
  const csvFiles = readNewLogFiles(logsBefore, '.csv');
  assert.equal(csvFiles.length, 1, 'expected exactly one new CSV file');
  const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, 'home');
  assert.equal(rows[0].status, '200');
  assert.ok(Number(rows[0].ttfb_ms) > 0);
});
