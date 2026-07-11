#!/usr/bin/env node
import path from 'node:path';
import {
  applyBreaker,
  configFilesFromArgs,
  failureSignature,
  initWorkspace,
  isoStamp,
  latestRun,
  loadSpec,
  loadState,
  nextState,
  runCheck,
  runsDirFor,
  statePathFor,
  writeJson
} from '../lib/core.mjs';

function parseArgs(argv) {
  const args = { _: [], root: process.cwd(), json: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = path.resolve(argv[++i]);
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

const HELP = `loop-engineering - verifiable agent work loops

Usage:
  loop-engineering init [--root <workspace>] [--force]
  loop-engineering run --config configs/loops/name.json [--root <workspace>] [--json]
  loop-engineering verify [--config configs/loops/name.json] [--root <workspace>]
  loop-engineering status [--config configs/loops/name.json] [--root <workspace>]

Exit codes:
  0 success/report-only
  2 breaker escalation or paused loop
  1 invalid spec, command error outside a check, or runtime failure`;

async function runCommand(args) {
  if (!args.config) throw new Error('run requires --config.');
  const root = args.root;
  const { spec, file: specPath } = await loadSpec(root, args.config);
  const state = await loadState(root, spec);
  if (state.paused) {
    const reason = typeof state.pauseReason === 'string' ? state.pauseReason : 'state.paused=true';
    console.error(`Loop ${spec.id} is paused: ${reason}`);
    return 2;
  }

  const runId = `${isoStamp()}_${spec.id}`;
  const startedAt = new Date();
  const results = [];
  let runtimeError = null;

  for (const check of spec.checks) {
    if (Date.now() - startedAt.getTime() > (spec.maxRuntimeMs ?? 120000)) {
      runtimeError = `maxRuntimeMs exceeded before check ${check.id}`;
      break;
    }
    results.push(await runCheck(root, check));
  }

  const checksOk = runtimeError === null && results.every((r) => r.ok);
  const outcome = checksOk ? 'success' : 'failure';
  const signature = runtimeError ? `runtime:${runtimeError}` : failureSignature(results);
  const breaker = applyBreaker(spec, state, outcome, signature);
  const finishedAt = new Date().toISOString();
  const runPath = path.join(runsDirFor(root, spec.id), `${runId}.json`);
  const run = {
    version: 1,
    runId,
    loopId: spec.id,
    goal: spec.goal,
    level: spec.level,
    mode: spec.mode,
    specPath: path.relative(root, specPath),
    startedAt: startedAt.toISOString(),
    finishedAt,
    durationMs: Date.parse(finishedAt) - startedAt.getTime(),
    outcome,
    failureSignature: signature,
    breaker,
    runtimeError,
    checks: results,
    runPath: path.relative(root, runPath)
  };

  await writeJson(runPath, run);
  await writeJson(statePathFor(root, spec.id), nextState(state, run));

  if (args.json) {
    console.log(JSON.stringify(run, null, 2));
  } else {
    console.log(`${spec.id}: ${outcome}${breaker.escalated ? ' (ESCALATED)' : ''}`);
    console.log(`run: ${path.relative(root, runPath)}`);
    if (breaker.escalated || outcome === 'failure') console.log(`reason: ${breaker.reason}`);
  }

  return breaker.escalated ? 2 : 0;
}

async function verifyCommand(args) {
  const files = await configFilesFromArgs(args.root, args.config ? ['--config', args.config] : []);
  if (files.length === 0) throw new Error('No loop configs found.');
  const reports = [];
  for (const file of files) {
    const { spec } = await loadSpec(args.root, file);
    const state = await loadState(args.root, spec);
    const latest = await latestRun(args.root, spec.id);
    reports.push({
      config: file,
      loopId: spec.id,
      level: spec.level,
      mode: spec.mode,
      checks: spec.checks.length,
      stateOk: state.version === 1 && state.loopId === spec.id,
      latestRun: latest?.run?.runId ?? null,
      latestOutcome: latest?.run?.outcome ?? null
    });
  }
  if (args.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const r of reports) {
      const status = r.stateOk ? 'ok' : 'fail';
      console.log(`${status} ${r.loopId} (${r.level}/${r.mode}) checks=${r.checks} latest=${r.latestOutcome ?? 'none'}`);
    }
  }
  return reports.every((r) => r.stateOk) ? 0 : 1;
}

async function statusCommand(args) {
  const files = await configFilesFromArgs(args.root, args.config ? ['--config', args.config] : []);
  if (files.length === 0) throw new Error('No loop configs found.');
  const reports = [];
  for (const file of files) {
    const { spec } = await loadSpec(args.root, file);
    const state = await loadState(args.root, spec);
    const latest = await latestRun(args.root, spec.id);
    reports.push({
      loopId: spec.id,
      goal: spec.goal,
      level: spec.level,
      mode: spec.mode,
      paused: Boolean(state.paused),
      runs: state.runs,
      lastOutcome: state.lastOutcome,
      consecutiveFailures: state.consecutiveFailures,
      latestRun: latest?.file ?? null
    });
  }
  if (args.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    for (const r of reports) {
      console.log(r.loopId);
      console.log(`  goal: ${r.goal}`);
      console.log(`  level/mode: ${r.level}/${r.mode}`);
      console.log(`  paused: ${r.paused ? 'yes' : 'no'}`);
      console.log(`  runs: ${r.runs}`);
      console.log(`  last outcome: ${r.lastOutcome ?? 'none'}`);
      console.log(`  consecutive failures: ${r.consecutiveFailures}`);
      console.log(`  latest run: ${r.latestRun ?? 'none'}`);
    }
  }
  return 0;
}

async function initCommand(args) {
  const config = await initWorkspace(args.root, { force: args.force });
  console.log(`initialized loop engineering at ${args.root}`);
  console.log(`config: ${config}`);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (args.help || !command) {
    console.log(HELP);
    return args.help ? 0 : 1;
  }
  if (command === 'init') return initCommand(args);
  if (command === 'run') return runCommand(args);
  if (command === 'verify') return verifyCommand(args);
  if (command === 'status') return statusCommand(args);
  throw new Error(`Unknown command: ${command}`);
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
