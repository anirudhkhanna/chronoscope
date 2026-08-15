import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'child_process';
import { startTestServer } from './server.mjs';
import { writeTempConfig, removeFile, spawnTool, sleep, findTestChromeMainPid, runForHitsAndGetFiles, parseCsv, snapshotLogFiles, cleanupNewLogFiles } from './helpers.mjs';
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

test('error handling: a hit against a non-resolving hostname records an error and the run continues to the next hit', async () => {
  const p = writeTempConfig({
    testUrls: {
      bad: 'http://this-host-does-not-exist.invalid/',
      good: `${testServer.baseUrl}/`,
    },
  });
  try {
    const { code, csvFiles } = await runForHitsAndGetFiles(['--config=' + p, '--only=bad,good', '--interval=0'], 2, { timeoutMs: 20000 });
    assert.equal(code, 0);
    const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
    const badRow = rows.find((r) => r.target === 'bad');
    const goodRow = rows.find((r) => r.target === 'good');
    assert.ok(badRow, 'expected a row for the bad-hostname target');
    assert.notEqual(badRow.error, '');
    assert.equal(badRow.status, '');
    assert.ok(goodRow, 'expected the good target to still get hit despite the other one failing');
    assert.equal(goodRow.status, '200');
  } finally {
    removeFile(p);
  }
});

test('error handling: killing the underlying Chrome mid-run triggers a one-shot relaunch-and-retry, not a permanent failure', async () => {
  const p = writeTempConfig({ testUrls: { home: `${testServer.baseUrl}/` } });
  const tool = spawnTool(['--config=' + p, '--only=home', '--interval=1', '--jitter=0']);
  try {
    // Let it complete one real hit first, so we know Chrome is fully up.
    await tool.waitForOutput(/Σ n=1/, 10000);
    const pid = findTestChromeMainPid();
    assert.ok(pid, 'expected to find the running test Chrome process');
    execSync(`kill -9 ${pid}`);
    // The tool should notice (either before or during its next hit) and
    // relaunch, then keep going rather than dying or looping on failures.
    await tool.waitForOutput(/relaunching/, 10000);
    await tool.waitForOutput(/Σ n=2/, 10000);
    tool.stop('SIGINT');
    const { code } = await tool.waitForExit();
    assert.equal(code, 0);
  } finally {
    tool.stop('SIGKILL');
    removeFile(p);
  }
});

test('shutdown: a normal run leaves no orphaned Chrome process behind after SIGINT', async () => {
  const p = writeTempConfig({ testUrls: { home: `${testServer.baseUrl}/` } });
  try {
    const { code } = await runForHitsAndGetFiles(['--config=' + p, '--only=home', '--interval=0.2', '--jitter=0'], 2).then((r) => r);
    assert.equal(code, 0);
    await sleep(1000); // give the OS a moment to fully reap child processes
    const pid = findTestChromeMainPid();
    assert.equal(pid, null, 'expected no chronoscope-launched Chrome process to remain running');
  } finally {
    removeFile(p);
  }
});
