// CLI flag parsing and validation. resolveRuntimeConfig takes allTargets/site
// as explicit parameters (rather than importing them as shared globals) so
// this module has no dependency on when/how the config was loaded — the
// entry point resolves the config first, then calls in here.
import { NETWORK_PRESETS, MOBILE_PRESETS, DEFAULT_MOBILE_PRESET, TOOL_DEFAULTS } from './constants.mjs';
import { describeTargets } from './config.mjs';

export function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  return args;
}

export function resolveRuntimeConfig(argv, allTargets, site) {
  const cli = parseArgs(argv);

  let targets = allTargets;
  if (cli.only) {
    const wanted = String(cli.only).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (!wanted.includes('all')) {
      targets = allTargets.filter((t) => wanted.includes(t.group) || wanted.includes(t.name));
      if (targets.length === 0) {
        console.error(`--only=${cli.only} matched no targets.\n\n${describeTargets(allTargets)}`);
        process.exit(1);
      }
    }
  }

  let intervalMs = TOOL_DEFAULTS.intervalMs;
  if (cli.interval !== undefined) {
    const seconds = Number(cli.interval);
    if (Number.isNaN(seconds) || seconds < 0) {
      console.error(`--interval must be a non-negative number of seconds, got "${cli.interval}"`);
      process.exit(1);
    }
    intervalMs = seconds * 1000;
  }

  let jitterMs = TOOL_DEFAULTS.jitterMs;
  if (cli.jitter !== undefined) {
    const seconds = Number(cli.jitter);
    if (Number.isNaN(seconds) || seconds < 0) {
      console.error(`--jitter must be a non-negative number of seconds, got "${cli.jitter}"`);
      process.exit(1);
    }
    jitterMs = seconds * 1000;
  }
  jitterMs = Math.min(jitterMs, intervalMs); // never let jitter push below a 0 floor beyond what --interval already implies

  let alarmGapMs = site.alarmGapMs;
  if (cli['alarm-gap'] !== undefined) {
    const ms = Number(cli['alarm-gap']);
    if (Number.isNaN(ms) || ms < 0) {
      console.error(`--alarm-gap must be a non-negative number of ms, got "${cli['alarm-gap']}"`);
      process.exit(1);
    }
    alarmGapMs = ms;
  }

  let alarmGapRatio = site.alarmGapRatio;
  if (cli['alarm-ratio'] !== undefined) {
    const ratio = Number(cli['alarm-ratio']);
    if (Number.isNaN(ratio) || ratio <= 0) {
      console.error(`--alarm-ratio must be a positive number, got "${cli['alarm-ratio']}"`);
      process.exit(1);
    }
    alarmGapRatio = ratio;
  }

  let networkProfileName = 'none';
  let networkProfile = null;
  const hasCustomNetworkFlag = cli['network-rtt'] !== undefined || cli['network-down'] !== undefined || cli['network-up'] !== undefined;

  if (hasCustomNetworkFlag) {
    const allGiven = cli['network-rtt'] !== undefined && cli['network-down'] !== undefined && cli['network-up'] !== undefined;
    const rttMs = Number(cli['network-rtt']);
    const downloadKbps = Number(cli['network-down']);
    const uploadKbps = Number(cli['network-up']);
    const allValid = [rttMs, downloadKbps, uploadKbps].every((n) => !Number.isNaN(n) && n >= 0);
    if (!allGiven || !allValid) {
      console.error('--network-rtt, --network-down, and --network-up must all be given together as non-negative numbers.');
      process.exit(1);
    }
    networkProfileName = 'custom';
    networkProfile = { rttMs, downloadKbps, uploadKbps };
  } else if (cli.network !== undefined && cli.network !== 'none') {
    const preset = NETWORK_PRESETS[cli.network];
    if (!preset) {
      console.error(`--network=${cli.network} is not a known preset. Valid: none, ${Object.keys(NETWORK_PRESETS).join(', ')}, or use --network-rtt/--network-down/--network-up for a custom profile.`);
      process.exit(1);
    }
    networkProfileName = cli.network;
    networkProfile = preset;
  }

  let deviceProfileName = 'desktop';
  let deviceProfile = null;
  if (cli.device !== undefined) {
    const preset = MOBILE_PRESETS[cli.device];
    if (!preset) {
      console.error(`--device=${cli.device} is not a known device. Valid: ${Object.keys(MOBILE_PRESETS).join(', ')}.`);
      process.exit(1);
    }
    deviceProfileName = cli.device;
    deviceProfile = preset;
  } else if (cli.mobile) {
    deviceProfileName = DEFAULT_MOBILE_PRESET;
    deviceProfile = MOBILE_PRESETS[DEFAULT_MOBILE_PRESET];
  }

  const disableJs = Boolean(cli['no-js']);
  const reuseConnection = Boolean(cli['reuse-connection']);
  const devtools = Boolean(cli.devtools);
  const pauseOnAlarm = Boolean(cli['pause-on-alarm']);
  const newTabOnAlarm = Boolean(cli['new-tab-on-alarm']);
  if (newTabOnAlarm && !reuseConnection) {
    console.error('--new-tab-on-alarm requires --reuse-connection — it only makes sense when hits are landing on a shared, reused page to begin with.');
    process.exit(1);
  }
  // Popping DevTools open, or pausing only for alarms, only makes sense if
  // you're actually there to look — both imply --manual. This holds
  // regardless of --reuse-connection: main()'s loop picks the actual pause
  // mechanism (wait for a window close vs. wait for a terminal keypress)
  // based on reuseConnection, since the page never closes between hits there.
  // Exception: with --new-tab-on-alarm, plain --devtools no longer implies
  // pausing — its whole point is to have DevTools already attached and
  // recording on every tab (including the fresh ones opened after an alarm)
  // for LATER, unattended review, not to force you to be present right now.
  // --manual or --pause-on-alarm, passed explicitly, still force pausing
  // regardless — those are deliberate asks, not an automatic side effect of
  // wanting DevTools open.
  // --new-tab-on-alarm doesn't pause anything itself, but it's just as
  // pointless headless (nothing to come back and look at), so it forces the
  // same visible-window treatment.
  const manual = Boolean(cli.manual || (devtools && !newTabOnAlarm) || pauseOnAlarm);
  const needsWindow = manual || newTabOnAlarm;
  // Manual inspection needs a visible window — --manual implies --headed.
  const headless = (cli.headed || needsWindow) ? false : TOOL_DEFAULTS.headless;
  // --headed alone still keeps the window out of your way off-screen; --manual
  // means you need to actually see and click on it, so never push it off-screen.
  const pushOffscreen = TOOL_DEFAULTS.windowOffscreen && !needsWindow;

  return {
    targets, intervalMs, jitterMs, alarmGapMs, alarmGapRatio,
    networkProfileName, networkProfile, deviceProfileName, deviceProfile,
    headless, manual, pushOffscreen, devtools, pauseOnAlarm, disableJs, reuseConnection, newTabOnAlarm,
  };
}
