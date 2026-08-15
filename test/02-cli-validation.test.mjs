import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server.mjs';
import { writeTempConfig, removeFile, spawnTool, snapshotLogFiles, cleanupNewLogFiles, runForHits } from './helpers.mjs';

let testServer;
let configPath;
let logsBefore;

before(async () => {
  testServer = await startTestServer();
  configPath = writeTempConfig({
    name: 'CliValidation',
    testUrls: {
      home: `${testServer.baseUrl}/`,
      pdp: { widgetA: `${testServer.baseUrl}/?a=1`, widgetB: `${testServer.baseUrl}/?a=2` },
    },
  });
  logsBefore = snapshotLogFiles();
});

after(async () => {
  await testServer.stop();
  removeFile(configPath);
  cleanupNewLogFiles(logsBefore);
});

test('cli: an unrecognized flag prints a red alert but the run continues normally', async () => {
  const { code, tool } = await runForHits(['--config=' + configPath, '--only=home', '--reuse-connecton', '--interval=0'], 1);
  assert.equal(code, 0);
  assert.match(tool.stdout, /Unrecognized flag: --reuse-connecton/);
  assert.match(tool.stdout, /\x1b\[1m\x1b\[31m/); // bold red ANSI prefix
});

test('cli: multiple unrecognized flags are listed together, pluralized', async () => {
  const { code, tool } = await runForHits(['--config=' + configPath, '--only=home', '--reuse-connecton', '--devtool', '--interval=0'], 1);
  assert.equal(code, 0);
  assert.match(tool.stdout, /Unrecognized flags: --reuse-connecton, --devtool/);
});

test('cli: valid flags never trigger the unrecognized-flag alert', async () => {
  const { code, tool } = await runForHits(['--config=' + configPath, '--only=home', '--no-js', '--interval=0'], 1);
  assert.equal(code, 0);
  assert.doesNotMatch(tool.stdout, /Unrecognized flag/);
});

test('cli: --only with an invalid target lists what the config actually offers', async () => {
  const tool = spawnTool(['--config=' + configPath, '--only=nonexistent-target']);
  const { code } = await tool.waitForExit();
  assert.notEqual(code, 0);
  assert.match(tool.stdout + tool.stderr, /matched no targets/);
  assert.match(tool.stdout + tool.stderr, /home/);
  assert.match(tool.stdout + tool.stderr, /pdp-widgetA/);
});

test('cli: --interval rejects a negative value', async () => {
  const tool = spawnTool(['--config=' + configPath, '--interval=-1']);
  const { code } = await tool.waitForExit();
  assert.notEqual(code, 0);
  assert.match(tool.stdout + tool.stderr, /--interval/);
});

test('cli: --interval rejects a non-numeric value', async () => {
  const tool = spawnTool(['--config=' + configPath, '--interval=banana']);
  const { code } = await tool.waitForExit();
  assert.notEqual(code, 0);
});

test('cli: --jitter rejects a negative value', async () => {
  const tool = spawnTool(['--config=' + configPath, '--jitter=-1']);
  const { code } = await tool.waitForExit();
  assert.notEqual(code, 0);
});

test('cli: --alarm-gap rejects a negative value', async () => {
  const tool = spawnTool(['--config=' + configPath, '--alarm-gap=-5']);
  const { code } = await tool.waitForExit();
  assert.notEqual(code, 0);
});

test('cli: --alarm-ratio rejects zero and negative values', async () => {
  const tool = spawnTool(['--config=' + configPath, '--alarm-ratio=0']);
  const { code } = await tool.waitForExit();
  assert.notEqual(code, 0);
});

test('cli: --network rejects an unknown preset and lists the valid ones', async () => {
  const tool = spawnTool(['--config=' + configPath, '--network=blazing-fast']);
  const { code } = await tool.waitForExit();
  assert.notEqual(code, 0);
  assert.match(tool.stdout + tool.stderr, /fast-4g/);
  assert.match(tool.stdout + tool.stderr, /slow-3g/);
});

test('cli: --network-rtt alone (without --network-down/--network-up) is rejected', async () => {
  const tool = spawnTool(['--config=' + configPath, '--network-rtt=100']);
  const { code } = await tool.waitForExit();
  assert.notEqual(code, 0);
  assert.match(tool.stdout + tool.stderr, /--network-rtt.*--network-down.*--network-up|must all be given together/i);
});

test('cli: --device rejects an unknown device name', async () => {
  const tool = spawnTool(['--config=' + configPath, '--device=iphone-99']);
  const { code } = await tool.waitForExit();
  assert.notEqual(code, 0);
  assert.match(tool.stdout + tool.stderr, /pixel/);
});

test('cli: --new-tab-on-alarm without --reuse-connection is rejected', async () => {
  const tool = spawnTool(['--config=' + configPath, '--new-tab-on-alarm']);
  const { code } = await tool.waitForExit();
  assert.notEqual(code, 0);
  assert.match(tool.stdout + tool.stderr, /--new-tab-on-alarm requires --reuse-connection/);
});
