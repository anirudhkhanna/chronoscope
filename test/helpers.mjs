// Shared plumbing for spawning the real chronoscope.mjs CLI as a subprocess
// and asserting on its behavior end-to-end — every test in this suite drives
// the actual binary against a local test server (test/server.mjs), never
// mocks, so what passes here is what actually happens when you run the tool.
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const CHRONOSCOPE_PATH = path.join(REPO_ROOT, 'chronoscope.mjs');
export const LOGS_DIR = path.join(REPO_ROOT, 'logs');

let tmpCounter = 0;

export function writeTempConfig(obj) {
  tmpCounter += 1;
  const p = path.join(REPO_ROOT, `test/.tmp-config-${process.pid}-${tmpCounter}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

export function removeFile(p) {
  fs.rmSync(p, { force: true });
}

export function snapshotLogFiles() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  return new Set(fs.readdirSync(LOGS_DIR));
}

export function newLogFilesSince(before) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  return fs.readdirSync(LOGS_DIR).filter((f) => !before.has(f));
}

export function cleanupNewLogFiles(before) {
  for (const f of newLogFilesSince(before)) {
    fs.rmSync(path.join(LOGS_DIR, f), { force: true });
  }
}

export function readNewLogFiles(before, suffix) {
  return newLogFilesSince(before)
    .filter((f) => f.endsWith(suffix))
    .map((f) => path.join(LOGS_DIR, f));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Finds the PID of the specific real Chrome process a chronoscope.mjs
// invocation launched — matched via `--disable-blink-features=
// AutomationControlled` (a flag only launchBrowser() ever passes) plus
// `playwright_chromiumdev_profile-` (Playwright's own ephemeral temp
// profile, never the user's real Chrome data), excluding any `--type=`
// helper/renderer/GPU subprocess so exactly the main browser process comes
// back. Relies on the whole suite running with --test-concurrency=1 (only
// one chronoscope-launched Chrome exists at a time) — never touches
// anything else running on the machine.
export function findTestChromeMainPid() {
  const out = execSync('ps ax -o pid=,command=').toString();
  for (const line of out.split('\n')) {
    if (line.includes('playwright_chromiumdev_profile-') && line.includes('--disable-blink-features=AutomationControlled') && !line.includes('--type=')) {
      const m = line.trim().match(/^(\d+)\s/);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

export function countOccurrences(text, pattern) {
  const re = pattern instanceof RegExp
    ? new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return (text.match(re) || []).length;
}

// Parses a simple CSV (no embedded commas/quotes in our own output — the
// UA string is the only field that could plausibly contain one, and it's
// deliberately the last column so a naive split is still safe here).
export function parseCsv(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

export function parseJsonl(text) {
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

// Spawns chronoscope.mjs with the given CLI args. The process is left
// running (it always loops forever until a signal) — callers drive it with
// waitForOutput()/stop()/waitForExit().
export function spawnTool(args) {
  const proc = spawn(process.execPath, [CHRONOSCOPE_PATH, ...args], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  function waitForOutput(pattern, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const hay = stdout + stderr;
        const matched = pattern instanceof RegExp ? pattern.test(hay) : hay.includes(pattern);
        if (matched) { resolve(hay); return; }
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for output matching ${pattern}.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  function waitForExit(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill('SIGKILL');
        reject(new Error(`Process did not exit within ${timeoutMs}ms.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
      }, timeoutMs);
      proc.once('exit', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
  }

  return {
    proc,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    waitForOutput,
    waitForExit,
    sendInput(text = '\n') { proc.stdin.write(text); },
    stop(signal = 'SIGINT') { proc.kill(signal); },
  };
}

// Runs a tool invocation that's expected to hit `hitCount` targets and then
// stop itself (used for the many "just verify N hits behave a certain way"
// tests) — waits for that many per-hit timestamp lines, sends SIGINT, then
// waits for a clean exit.
export async function runForHits(args, hitCount, { timeoutMs = 15000 } = {}) {
  const tool = spawnTool(args);
  const timestampLine = /^\[\d{4}-\d{2}-\d{2}T/m;
  const start = Date.now();
  while (countOccurrences(tool.stdout, timestampLine) < hitCount) {
    if (Date.now() - start > timeoutMs) {
      tool.stop('SIGKILL');
      throw new Error(`Timed out waiting for ${hitCount} hits.\n--- stdout ---\n${tool.stdout}\n--- stderr ---\n${tool.stderr}`);
    }
    await sleep(50);
  }
  tool.stop('SIGINT');
  const { code, signal } = await tool.waitForExit(timeoutMs);
  return { tool, code, signal };
}

// Same as runForHits, but also snapshots logs/ immediately before spawning
// and returns exactly the files THIS run created — critical when several
// tests share one file (or run concurrently), since a snapshot taken once
// for a whole suite would let a later test pick up an earlier test's files.
export async function runForHitsAndGetFiles(args, hitCount, opts = {}) {
  const before = snapshotLogFiles();
  const { tool, code, signal } = await runForHits(args, hitCount, opts);
  return {
    tool,
    code,
    signal,
    csvFiles: readNewLogFiles(before, '.csv'),
    jsonlFiles: readNewLogFiles(before, '.jsonl'),
    summaryFiles: readNewLogFiles(before, '.json'),
  };
}
