// Config file loading and target flattening — all pure functions (aside from
// process.exit(1) on genuinely invalid input, which only fires when called).
// No module-level side effects: the entry point decides exactly when these
// run, which matters because --help must be able to print before any of
// this executes (see "Bootstrap order matters" in CLAUDE.md).
import fs from 'fs';
import path from 'path';
import { DEFAULT_CONFIG_PATH } from './constants.mjs';

export function findConfigPath(argv) {
  for (const arg of argv) {
    const m = arg.match(/^--config=(.*)$/);
    if (m) return m[1];
  }
  return DEFAULT_CONFIG_PATH;
}

export function loadSiteConfig(configPath) {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    console.error(
      `Config file not found: ${resolved}\n\n` +
      `Point at one with --config=<path>, or create ${DEFAULT_CONFIG_PATH} in the ` +
      `current directory. Run with --help to see the expected format.`
    );
    process.exit(1);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (err) {
    console.error(`Failed to parse config file ${resolved}: ${err.message}`);
    process.exit(1);
  }
  if (!raw.testUrls || typeof raw.testUrls !== 'object' || Array.isArray(raw.testUrls) || Object.keys(raw.testUrls).length === 0) {
    console.error(`Config file ${resolved} must have a non-empty "testUrls" object. Run with --help to see the expected format.`);
    process.exit(1);
  }
  return raw;
}

export function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    // Include the query string too — URLs that only differ by query (e.g.
    // faceted search/filter pages sharing one path) would otherwise all
    // slug to the same last path segment and collide.
    const base = (segments[segments.length - 1] || '') + (u.search ? `-${u.search.slice(1)}` : '');
    return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
  } catch {
    return '';
  }
}

// testUrls[group] can be a single URL string, an array of URLs, or an object
// mapping a short name to each URL — whichever shape fits that group best.
export function flattenTestUrls(testUrls) {
  const targets = [];
  const seenNames = new Set();

  function addTarget(name, group, url) {
    let finalName = name;
    let suffix = 2;
    while (seenNames.has(finalName)) {
      finalName = `${name}-${suffix}`;
      suffix += 1;
    }
    if (finalName !== name) {
      console.error(`Warning: target name "${name}" collided; renamed to "${finalName}". Give it an explicit name in the config to avoid this.`);
    }
    seenNames.add(finalName);
    targets.push({ name: finalName, group, url });
  }

  for (const [groupName, value] of Object.entries(testUrls)) {
    if (typeof value === 'string') {
      addTarget(groupName, groupName, value);
    } else if (Array.isArray(value)) {
      value.forEach((url, i) => {
        const slug = slugFromUrl(url) || String(i + 1);
        addTarget(`${groupName}-${slug}`, groupName, url);
      });
    } else if (value && typeof value === 'object') {
      for (const [subName, url] of Object.entries(value)) {
        addTarget(`${groupName}-${subName}`, groupName, url);
      }
    } else {
      console.error(`Invalid "testUrls.${groupName}": expected a URL string, an array of URLs, or an object of name -> URL.`);
      process.exit(1);
    }
  }
  return targets;
}

export function describeTargets(targets) {
  const groups = [...new Set(targets.map((t) => t.group))];
  return `Groups: ${groups.join(', ')}\nTargets: ${targets.map((t) => t.name).join(', ')}`;
}

export function validateHeaders(raw) {
  if (raw.headers === undefined) return {};
  const isPlainObject = raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers);
  const allStrings = isPlainObject && Object.values(raw.headers).every((v) => typeof v === 'string');
  if (!isPlainObject || !allStrings) {
    console.error(`Config "headers" must be an object of header-name -> string value, e.g. {"X-Test": "1"}.`);
    process.exit(1);
  }
  return raw.headers;
}

// Resolves site identity (locale/timezone/UA/alarm thresholds/etc.) once at
// startup from the loaded config file, with toolDefaults as fallback for
// anything the config omits.
export function buildSite(siteConfigRaw, configPath, toolDefaults) {
  return {
    name: siteConfigRaw.name || 'site',
    configPath,
    serverTimingMetric: siteConfigRaw.serverTimingMetric || null,
    locale: siteConfigRaw.locale || toolDefaults.locale,
    timezoneId: siteConfigRaw.timezoneId || toolDefaults.timezoneId,
    queryParam: siteConfigRaw.queryParam || toolDefaults.queryParam,
    uaSuffix:
      siteConfigRaw.uaSuffix ||
      (siteConfigRaw.name
        ? `${siteConfigRaw.name.replace(/[^a-zA-Z0-9]/g, '')}-ChronoscopeLatencyBot/1.0`
        : 'ChronoscopeLatencyBot/1.0'),
    headers: validateHeaders(siteConfigRaw),
    alarmGapMs: typeof siteConfigRaw.alarmGapMs === 'number' ? siteConfigRaw.alarmGapMs : toolDefaults.alarmGapMs,
    alarmGapRatio: typeof siteConfigRaw.alarmGapRatio === 'number' ? siteConfigRaw.alarmGapRatio : toolDefaults.alarmGapRatio,
  };
}
