import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './server.mjs';
import { writeTempConfig, removeFile, spawnTool, snapshotLogFiles, cleanupNewLogFiles, runForHits, runForHitsAndGetFiles, parseCsv } from './helpers.mjs';
import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from './helpers.mjs';

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

test('config: missing config file exits non-zero with a clear error', async () => {
  const tool = spawnTool(['--config=' + path.join(REPO_ROOT, 'test/.does-not-exist.json')]);
  const { code } = await tool.waitForExit();
  assert.notEqual(code, 0);
  assert.match(tool.stderr + tool.stdout, /not found|no such file|ENOENT/i);
});

test('config: malformed JSON exits non-zero with a clear error', async () => {
  const p = path.join(REPO_ROOT, 'test/.tmp-bad.json');
  fs.writeFileSync(p, '{ this is not json');
  try {
    const tool = spawnTool(['--config=' + p]);
    const { code } = await tool.waitForExit();
    assert.notEqual(code, 0);
  } finally {
    removeFile(p);
  }
});

test('config: missing testUrls exits non-zero with a clear error', async () => {
  const p = writeTempConfig({ name: 'NoTargets' });
  try {
    const tool = spawnTool(['--config=' + p]);
    const { code } = await tool.waitForExit();
    assert.notEqual(code, 0);
    assert.match(tool.stderr + tool.stdout, /testUrls/);
  } finally {
    removeFile(p);
  }
});

test('config: a testUrls group whose value is not a string/array/object exits non-zero', async () => {
  const p = writeTempConfig({ testUrls: { home: 12345 } });
  try {
    const tool = spawnTool(['--config=' + p]);
    const { code } = await tool.waitForExit();
    assert.notEqual(code, 0);
    assert.match(tool.stderr + tool.stdout, /Invalid "testUrls\.home"/);
  } finally {
    removeFile(p);
  }
});

test('config: --help works even when the config is missing/broken (bootstrap order)', async () => {
  const p = path.join(REPO_ROOT, 'test/.does-not-exist-either.json');
  const tool = spawnTool(['--config=' + p, '--help']);
  const { code } = await tool.waitForExit();
  assert.equal(code, 0);
  assert.match(tool.stdout, /Chronoscope/);
  assert.match(tool.stdout, /Options:/);
});

test('config: testUrls shapes (string / array / object) all flatten to the right target names', async () => {
  const p = writeTempConfig({
    name: 'Shapes',
    testUrls: {
      home: `${testServer.baseUrl}/`,
      pdp: { widgetA: `${testServer.baseUrl}/?a=1`, widgetB: `${testServer.baseUrl}/?a=2` },
      search: [`${testServer.baseUrl}/?q=foo`, `${testServer.baseUrl}/?q=bar`],
    },
  });
  try {
    const tool = spawnTool(['--config=' + p, '--only=all', '--interval=0']);
    await tool.waitForOutput(/Targets\s+home, pdp-widgetA, pdp-widgetB, search-/);
    tool.stop();
    await tool.waitForExit();
  } finally {
    removeFile(p);
  }
});

test('config: colliding target names auto-rename with a warning', async () => {
  // "foo-bar" (a plain string group) and "foo" -> {"bar": ...} (an object
  // group) both flatten to the final target name "foo-bar" — a genuine
  // collision, unlike two differently-named groups which never collide.
  const p = writeTempConfig({
    name: 'Dupes',
    testUrls: {
      'foo-bar': `${testServer.baseUrl}/?x=1`,
      foo: { bar: `${testServer.baseUrl}/?x=2` },
    },
  });
  try {
    const tool = spawnTool(['--config=' + p, '--only=all', '--interval=0']);
    await tool.waitForOutput(/Targets/);
    tool.stop();
    await tool.waitForExit();
    assert.match(tool.stdout + tool.stderr, /collided/i);
  } finally {
    removeFile(p);
  }
});

test('config: custom headers are actually sent with every request', async () => {
  const p = writeTempConfig({
    name: 'Headers',
    headers: { 'X-Chronoscope-Test': 'hello-world' },
    testUrls: { home: `${testServer.baseUrl}/` },
  });
  try {
    await runForHits(['--config=' + p, '--interval=0'], 1);
    const received = testServer.getLastHeaders();
    assert.equal(received['x-chronoscope-test'], 'hello-world');
  } finally {
    removeFile(p);
  }
});

test('config: uaSuffix defaults to "<Name>-ChronoscopeLatencyBot/1.0" when a name is given', async () => {
  const p = writeTempConfig({
    name: 'Acme',
    testUrls: { home: `${testServer.baseUrl}/` },
  });
  try {
    await runForHits(['--config=' + p, '--interval=0'], 1);
    const ua = testServer.getLastHeaders()['user-agent'];
    assert.match(ua, /Acme-ChronoscopeLatencyBot\/1\.0/);
  } finally {
    removeFile(p);
  }
});

test('config: uaSuffix defaults to "ChronoscopeLatencyBot/1.0" when no name is given', async () => {
  const p = writeTempConfig({
    testUrls: { home: `${testServer.baseUrl}/` },
  });
  try {
    await runForHits(['--config=' + p, '--interval=0'], 1);
    const ua = testServer.getLastHeaders()['user-agent'];
    assert.match(ua, /(?<!-)ChronoscopeLatencyBot\/1\.0/);
    assert.doesNotMatch(ua, /-ChronoscopeLatencyBot/);
  } finally {
    removeFile(p);
  }
});

test('config: an explicit uaSuffix overrides the default entirely', async () => {
  const p = writeTempConfig({
    name: 'Acme',
    uaSuffix: 'TotallyCustomBot/9.9',
    testUrls: { home: `${testServer.baseUrl}/` },
  });
  try {
    await runForHits(['--config=' + p, '--interval=0'], 1);
    const ua = testServer.getLastHeaders()['user-agent'];
    assert.match(ua, /TotallyCustomBot\/9\.9/);
    assert.doesNotMatch(ua, /ChronoscopeLatencyBot/);
  } finally {
    removeFile(p);
  }
});

test('config: omitting serverTimingMetric skips the gap/alarm comparison but still measures TTFB', async () => {
  const p = writeTempConfig({
    testUrls: { home: `${testServer.baseUrl}/` },
  });
  try {
    const { code, csvFiles } = await runForHitsAndGetFiles(['--config=' + p, '--interval=0'], 1);
    assert.equal(code, 0);
    assert.equal(csvFiles.length, 1);
    const rows = parseCsv(fs.readFileSync(csvFiles[0], 'utf8'));
    assert.ok(Number(rows[0].ttfb_ms) > 0);
    assert.equal(rows[0].server_ms, '');
    assert.equal(rows[0].gap_ms, '');
    assert.equal(rows[0].alarm, '0');
  } finally {
    removeFile(p);
  }
});
