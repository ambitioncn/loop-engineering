import { access, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function isoStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function normalizeLoopId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error(`Invalid loop id: ${id}`);
  }
  return id;
}

export function safeRelativePath(p, label = 'path') {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) {
    throw new Error(`Invalid ${label}: ${p}`);
  }
  const normalized = path.normalize(p);
  if (path.isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Unsafe ${label}: ${p}`);
  }
  return normalized;
}

export async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function runtimeDirFor(root, id) {
  return path.join(root, 'runtime', 'loops', normalizeLoopId(id));
}

export function statePathFor(root, id) {
  return path.join(runtimeDirFor(root, id), 'state.json');
}

export function runsDirFor(root, id) {
  return path.join(runtimeDirFor(root, id), 'runs');
}

export async function loadSpec(root, configPath) {
  const file = path.resolve(root, configPath);
  const spec = await readJson(file);
  validateSpec(spec);
  return { spec, file };
}

export function validateSpec(spec) {
  normalizeLoopId(spec.id);
  if (typeof spec.goal !== 'string' || spec.goal.trim().length < 8) {
    throw new Error('Spec goal must be a meaningful string.');
  }
  if (!['L1', 'L2', 'L3'].includes(spec.level)) {
    throw new Error('Spec level must be L1, L2, or L3.');
  }
  if (!['report-only', 'assisted', 'unattended'].includes(spec.mode)) {
    throw new Error('Spec mode must be report-only, assisted, or unattended.');
  }
  if (!Array.isArray(spec.checks) || spec.checks.length === 0) {
    throw new Error('Spec checks must be a non-empty array.');
  }
  for (const check of spec.checks) validateCheck(check);
  if (spec.maxRuntimeMs !== undefined && !positiveInteger(spec.maxRuntimeMs)) {
    throw new Error('Spec maxRuntimeMs must be a positive integer.');
  }
  if (spec.breaker !== undefined) {
    const { maxConsecutiveFailures, sameFailureThreshold } = spec.breaker;
    if (maxConsecutiveFailures !== undefined && !positiveInteger(maxConsecutiveFailures)) {
      throw new Error('breaker.maxConsecutiveFailures must be a positive integer.');
    }
    if (sameFailureThreshold !== undefined && !positiveInteger(sameFailureThreshold)) {
      throw new Error('breaker.sameFailureThreshold must be a positive integer.');
    }
  }
}

function validateCheck(check) {
  if (typeof check.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(check.id)) {
    throw new Error(`Invalid check id: ${check.id}`);
  }
  if (!['command', 'files'].includes(check.type)) {
    throw new Error(`Unsupported check type for ${check.id}: ${check.type}`);
  }
  if (check.type === 'command') {
    if (typeof check.cmd !== 'string' || check.cmd.trim().length === 0) {
      throw new Error(`Command check ${check.id} needs cmd.`);
    }
    if (check.expectExitCode !== undefined && !Number.isInteger(check.expectExitCode)) {
      throw new Error(`Command check ${check.id} expectExitCode must be an integer.`);
    }
    if (check.timeoutMs !== undefined && !positiveInteger(check.timeoutMs)) {
      throw new Error(`Command check ${check.id} timeoutMs must be a positive integer.`);
    }
  }
  if (check.type === 'files') {
    if (!Array.isArray(check.paths) || check.paths.length === 0) {
      throw new Error(`Files check ${check.id} needs paths.`);
    }
    for (const p of check.paths) safeRelativePath(p, `check path for ${check.id}`);
  }
}

function positiveInteger(n) {
  return Number.isInteger(n) && n > 0;
}

export async function loadState(root, spec) {
  const stateFile = statePathFor(root, spec.id);
  if (!(await exists(stateFile))) {
    return {
      version: 1,
      loopId: spec.id,
      goal: spec.goal,
      paused: false,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      runs: 0,
      consecutiveFailures: 0,
      lastOutcome: null,
      lastFailureSignature: null,
      sameFailureCount: 0,
      lastRunId: null,
      lastRunPath: null
    };
  }
  const state = await readJson(stateFile);
  if (state.version !== 1 || state.loopId !== spec.id) {
    throw new Error(`Invalid state file for loop ${spec.id}.`);
  }
  return state;
}

export async function runCheck(root, check) {
  const startedAt = new Date().toISOString();
  if (check.type === 'files') {
    const missing = [];
    const present = [];
    for (const rel of check.paths) {
      const safe = safeRelativePath(rel, `check path for ${check.id}`);
      const full = path.join(root, safe);
      if (await exists(full)) present.push(rel);
      else missing.push(rel);
    }
    return {
      id: check.id,
      type: check.type,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: missing.length === 0,
      present,
      missing
    };
  }

  const timeoutMs = check.timeoutMs ?? 30000;
  const result = await runCommand(check.cmd, { cwd: root, timeoutMs });
  const expected = check.expectExitCode ?? 0;
  return {
    id: check.id,
    type: check.type,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: result.exitCode === expected,
    cmd: check.cmd,
    expectExitCode: expected,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr)
  };
}

export function runCommand(cmd, options = {}) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-lc', cmd], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 30000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? (signal ? 128 : 1),
        timedOut,
        stdout,
        stderr
      });
    });
  });
}

function trimOutput(value) {
  const max = 12000;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n... <truncated ${value.length - max} chars>`;
}

function trimTail(value, max = 4000) {
  if (!value) return '';
  if (value.length <= max) return value;
  return `... <truncated ${value.length - max} chars>\n${value.slice(-max)}`;
}

export function failureSignature(results) {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return null;
  return failed.map((r) => {
    if (r.type === 'files') return `${r.id}:missing:${r.missing.join(',')}`;
    const firstErr = (r.stderr || r.stdout || '').split('\n').find((line) => line.trim()) || '';
    return `${r.id}:exit:${r.exitCode}:${normalizeVolatile(firstErr)}`;
  }).join('|');
}

function normalizeVolatile(text) {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<ts>')
    .replace(/0x[0-9a-fA-F]+/g, '<addr>')
    .replace(/:\d+(:\d+)?/g, ':#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function applyBreaker(spec, state, outcome, signature) {
  const breaker = spec.breaker ?? {};
  const maxConsecutiveFailures = breaker.maxConsecutiveFailures ?? 3;
  const sameFailureThreshold = breaker.sameFailureThreshold ?? 2;

  if (outcome !== 'failure') {
    return { escalated: false, trigger: 'ok', reason: 'Loop checks passed.' };
  }

  const nextConsecutive = (state.consecutiveFailures ?? 0) + 1;
  const nextSame = signature && signature === state.lastFailureSignature
    ? (state.sameFailureCount ?? 1) + 1
    : 1;

  if (nextConsecutive >= maxConsecutiveFailures) {
    return {
      escalated: true,
      trigger: 'consecutive-failures',
      reason: `Failure repeated for ${nextConsecutive} consecutive runs.`
    };
  }
  if (nextSame >= sameFailureThreshold) {
    return {
      escalated: true,
      trigger: 'same-failure',
      reason: `Same failure signature repeated ${nextSame} times.`
    };
  }
  return {
    escalated: false,
    trigger: 'failure-observed',
    reason: `Failure observed (${nextConsecutive}/${maxConsecutiveFailures} consecutive).`
  };
}

export function nextState(state, run) {
  const failure = run.outcome === 'failure';
  const sameFailureCount = failure && run.failureSignature === state.lastFailureSignature
    ? (state.sameFailureCount ?? 1) + 1
    : failure ? 1 : 0;
  return {
    ...state,
    updatedAt: run.finishedAt,
    runs: (state.runs ?? 0) + 1,
    consecutiveFailures: failure ? (state.consecutiveFailures ?? 0) + 1 : 0,
    lastOutcome: run.outcome,
    lastFailureSignature: run.failureSignature,
    sameFailureCount,
    lastRunId: run.runId,
    lastRunPath: run.runPath,
    lastBreaker: run.breaker
  };
}

export async function configFilesFromArgs(root, argv) {
  const configs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') configs.push(argv[++i]);
  }
  if (configs.length > 0) return configs;
  const dir = path.join(root, 'configs', 'loops');
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join('configs', 'loops', f));
  } catch {
    return [];
  }
}

export async function latestRun(root, id) {
  const dir = runsDirFor(root, id);
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    if (files.length === 0) return null;
    const file = path.join(dir, files[files.length - 1]);
    return { file: path.relative(root, file), run: await readJson(file) };
  } catch {
    return null;
  }
}

export async function recentRuns(root, id, options = {}) {
  const limit = options.limit ?? 20;
  const dir = runsDirFor(root, id);
  try {
    const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort().slice(-limit);
    const runs = [];
    for (const file of files) {
      const full = path.join(dir, file);
      try {
        runs.push({ file: path.relative(root, full), run: await readJson(full) });
      } catch (err) {
        runs.push({
          file: path.relative(root, full),
          readError: err instanceof Error ? err.message : String(err)
        });
      }
    }
    return runs;
  } catch {
    return [];
  }
}

export async function summarizeLoopRuns(root, options = {}) {
  const ids = await targetRuntimeIds(root, options);
  const summaries = [];
  for (const id of ids) {
    const entries = await recentRuns(root, id, { limit: options.limit ?? 20 });
    const readable = entries.filter((entry) => entry.run && runMatchesTarget(entry.run, id, options));
    const counts = {};
    const durations = [];
    const failures = [];
    for (const entry of readable) {
      const run = entry.run;
      const status = run.status ?? run.outcome ?? 'unknown';
      counts[status] = (counts[status] ?? 0) + 1;
      const duration = Number.isFinite(run.durationMs)
        ? run.durationMs
        : Date.parse(run.finishedAt ?? '') - Date.parse(run.startedAt ?? '');
      if (Number.isFinite(duration) && duration >= 0) durations.push(duration);
      if (isFailureRun(run)) failures.push(failureSummary(entry.file, run));
    }
    summaries.push({
      id,
      inspectedRuns: entries.length,
      readableRuns: readable.length,
      unreadableRuns: entries.filter((entry) => entry.readError).length,
      skippedRuns: entries.filter((entry) => entry.run && !runMatchesTarget(entry.run, id, options)).length,
      counts,
      successRate: readable.length ? Number(((successCount(readable) / readable.length) * 100).toFixed(1)) : null,
      averageDurationMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      latestRun: readable[readable.length - 1]?.file ?? null,
      latestStatus: readable[readable.length - 1]?.run?.status ?? readable[readable.length - 1]?.run?.outcome ?? null,
      recentFailures: failures.slice(-5).reverse()
    });
  }
  return summaries;
}

function runMatchesTarget(run, id, options) {
  if (options.queue) return run.queue === id || (!run.outcome && run.status && run.loopId === id);
  if (options.id) return run.loopId === id && Boolean(run.outcome);
  return true;
}

async function targetRuntimeIds(root, options) {
  if (options.id) return [normalizeLoopId(options.id)];
  if (options.queue) return [normalizeLoopId(options.queue)];
  const dir = path.join(root, 'runtime', 'loops');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

function isFailureRun(run) {
  if (run.outcome) return run.outcome !== 'success' || run.breaker?.escalated;
  if (run.status) return !['completed', 'empty'].includes(run.status);
  return false;
}

function successCount(entries) {
  return entries.filter((entry) => {
    const run = entry.run;
    if (run.outcome) return run.outcome === 'success' && !run.breaker?.escalated;
    if (run.status) return ['completed', 'empty'].includes(run.status);
    return false;
  }).length;
}

function failureSummary(file, run) {
  const failedChecks = Array.isArray(run.checks)
    ? run.checks.filter((check) => !check.ok).map((check) => ({
      id: check.id,
      exitCode: check.exitCode ?? null,
      missing: check.missing ?? null
    }))
    : [];
  return {
    file,
    runId: run.runId ?? null,
    status: run.status ?? run.outcome ?? 'unknown',
    reason: run.failureSignature ?? run.runtimeError ?? run.breaker?.reason ?? run.dispatch?.stderr?.split('\n').find(Boolean) ?? null,
    failedChecks
  };
}

export async function doctorReport(root, options = {}) {
  const checks = [];
  const add = (id, level, ok, detail = null) => checks.push({ id, level, ok, detail });
  add('root-exists', 'fail', await exists(root), root);
  const configsDir = path.join(root, 'configs', 'loops');
  add('configs-dir', 'warn', await exists(configsDir), path.relative(root, configsDir));
  const runtimeDir = path.join(root, 'runtime', 'loops');
  add('runtime-dir', 'warn', await exists(runtimeDir), path.relative(root, runtimeDir));

  const loopConfigs = await configFilesFromArgs(root, []);
  add('loop-configs-found', 'warn', loopConfigs.length > 0, `${loopConfigs.length} loop config(s)`);
  for (const file of loopConfigs) {
    try {
      const { spec } = await loadSpec(root, file);
      const state = await loadState(root, spec);
      const latest = await latestMatchingRun(root, spec.id, (run) => run.loopId === spec.id);
      add(`loop:${spec.id}`, 'fail', state.version === 1 && state.loopId === spec.id, {
        config: file,
        level: spec.level,
        mode: spec.mode,
        checks: spec.checks.length,
        latestRun: latest?.file ?? null,
        latestOutcome: latest?.run?.outcome ?? null,
        consecutiveFailures: state.consecutiveFailures ?? 0,
        paused: Boolean(state.paused)
      });
      if (latest?.run && isFailureRun(latest.run)) {
        add(`loop:${spec.id}:latest`, 'warn', false, failureSummary(latest.file, latest.run));
      }
    } catch (err) {
      add(`loop-config:${file}`, 'fail', false, err instanceof Error ? err.message : String(err));
    }
  }

  const queueConfigs = await queueConfigFiles(root);
  add('queue-configs-found', 'warn', queueConfigs.length > 0, `${queueConfigs.length} queue config(s)`);
  for (const file of queueConfigs) {
    try {
      const config = await loadQueueConfig(root, file);
      const optionsForQueue = mergeQueueOptions(config, {});
      const status = await queueStatus(root, optionsForQueue.queue);
      add(`queue:${optionsForQueue.queue}`, 'fail', true, {
        config: file,
        dispatcher: optionsForQueue.dispatcher ?? null,
        preflightConfig: optionsForQueue.preflightConfig ?? null,
        status
      });
      if (status.locked) add(`queue:${optionsForQueue.queue}:lock`, 'warn', false, status.lockExpiresAt);
      if (status.active > 0) add(`queue:${optionsForQueue.queue}:active`, 'warn', false, `${status.active} active task(s)`);
      if (status.failed > 0) add(`queue:${optionsForQueue.queue}:failed`, 'warn', false, `${status.failed} failed task(s)`);
    } catch (err) {
      add(`queue-config:${file}`, 'fail', false, err instanceof Error ? err.message : String(err));
    }
  }

  const summaries = await summarizeLoopRuns(root, { limit: options.limit ?? 10 });
  return {
    version: 1,
    root,
    generatedAt: new Date().toISOString(),
    ok: checks.every((check) => check.ok || check.level === 'warn'),
    failCount: checks.filter((check) => !check.ok && check.level === 'fail').length,
    warnCount: checks.filter((check) => !check.ok && check.level === 'warn').length,
    checks,
    summaries
  };
}

async function latestMatchingRun(root, id, predicate) {
  const entries = await recentRuns(root, id, { limit: 50 });
  for (const entry of entries.slice().reverse()) {
    if (entry.run && predicate(entry.run)) return entry;
  }
  return null;
}

async function queueConfigFiles(root) {
  const dir = path.join(root, 'configs', 'loops', 'queues');
  try {
    return (await readdir(dir))
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => path.join('configs', 'loops', 'queues', file));
  } catch {
    return [];
  }
}

export async function initWorkspace(root, options = {}) {
  const templatesDir = path.join(PACKAGE_ROOT, 'templates');
  const configsDir = path.join(root, 'configs', 'loops');
  await mkdir(configsDir, { recursive: true });
  await mkdir(path.join(root, 'runtime', 'loops'), { recursive: true });
  const target = path.join(configsDir, `${options.template ?? 'workspace-health'}.json`);
  if (!(await exists(target)) || options.force) {
    await copyFile(path.join(templatesDir, 'workspace-health.json'), target);
  }
  return path.relative(root, target);
}

export async function initQueueConfig(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const templatesDir = path.join(PACKAGE_ROOT, 'templates');
  const configsDir = path.join(root, 'configs', 'loops', 'queues');
  await mkdir(configsDir, { recursive: true });
  await ensureQueueDirs(root, normalized);
  await initWorkspace(root, { force: false });
  const target = path.join(configsDir, `${normalized}.json`);
  if (!(await exists(target)) || options.force) {
    const template = await readJson(path.join(templatesDir, 'queue-runner.json'));
    await writeJson(target, {
      ...template,
      queue: normalized,
      dispatcher: template.dispatcher ?? 'node scripts/dispatch-task.mjs'
    });
  }
  return path.relative(root, target);
}

export async function packageFileSizeSummary() {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const s = await stat(full);
        files.push({ file: path.relative(PACKAGE_ROOT, full), bytes: s.size });
      }
    }
  }
  await walk(PACKAGE_ROOT);
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

export function queueDirFor(root, queue) {
  return runtimeDirFor(root, queue);
}

export function queueSubdirFor(root, queue, subdir) {
  return path.join(queueDirFor(root, queue), subdir);
}

export async function ensureQueueDirs(root, queue) {
  normalizeLoopId(queue);
  await Promise.all(['inbox', 'active', 'done', 'failed', 'runs', 'canceled']
    .map((subdir) => mkdir(queueSubdirFor(root, queue, subdir), { recursive: true })));
}

export function taskIdForTitle(title, date = new Date()) {
  const slug = (title || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
  return `${isoStamp(date)}_${slug}`;
}

export async function enqueueTask(root, options) {
  const queue = normalizeLoopId(options.queue);
  await ensureQueueDirs(root, queue);
  let body = options.task ?? '';
  if (options.file) {
    body = await readFile(path.resolve(root, safeRelativePath(options.file, 'task file')), 'utf8');
  }
  if (typeof options.title !== 'string' || !options.title.trim()) {
    throw new Error('enqueue requires --title.');
  }
  if (typeof body !== 'string' || !body.trim()) {
    throw new Error('enqueue requires --task or --file.');
  }

  const id = taskIdForTitle(options.title);
  const task = {
    version: 1,
    id,
    queue,
    title: options.title.trim(),
    body: body.trim(),
    status: 'queued',
    enqueuedAt: new Date().toISOString()
  };
  const file = path.join(queueSubdirFor(root, queue, 'inbox'), `${id}.json`);
  await writeJson(file, task);
  return { task, file: path.relative(root, file) };
}

async function listJson(dir) {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

export async function queueStatus(root, queue) {
  normalizeLoopId(queue);
  await ensureQueueDirs(root, queue);
  const activeFiles = await listJson(queueSubdirFor(root, queue, 'active'));
  const lock = await readQueueLock(root, queue);
  return {
    queue,
    queued: (await listJson(queueSubdirFor(root, queue, 'inbox'))).length,
    active: activeFiles.length,
    done: (await listJson(queueSubdirFor(root, queue, 'done'))).length,
    failed: (await listJson(queueSubdirFor(root, queue, 'failed'))).length,
    canceled: (await listJson(queueSubdirFor(root, queue, 'canceled'))).length,
    runs: (await listJson(queueSubdirFor(root, queue, 'runs'))).length,
    locked: Boolean(lock && Date.parse(lock.expiresAt) > Date.now()),
    lockExpiresAt: lock?.expiresAt ?? null
  };
}

export async function loadQueueConfig(root, configPath) {
  if (!configPath) return {};
  const file = path.resolve(root, safeRelativePath(configPath, 'queue config'));
  const config = await readJson(file);
  if (config.queue !== undefined) normalizeLoopId(config.queue);
  if (config.preflightConfig !== undefined) safeRelativePath(config.preflightConfig, 'preflight config');
  if (config.timeoutMs !== undefined && !positiveInteger(config.timeoutMs)) {
    throw new Error('queue config timeoutMs must be a positive integer.');
  }
  if (config.leaseMs !== undefined && !positiveInteger(config.leaseMs)) {
    throw new Error('queue config leaseMs must be a positive integer.');
  }
  if (config.staleActiveMs !== undefined && !positiveInteger(config.staleActiveMs)) {
    throw new Error('queue config staleActiveMs must be a positive integer.');
  }
  if (config.retry !== undefined) validateRetryConfig(config.retry);
  if (config.dispatcher !== undefined && typeof config.dispatcher !== 'string') {
    throw new Error('queue config dispatcher must be a string.');
  }
  if (config.notifyCommand !== undefined && typeof config.notifyCommand !== 'string') {
    throw new Error('queue config notifyCommand must be a string.');
  }
  return { ...config, configPath };
}

function validateRetryConfig(retry) {
  if (retry.maxAttempts !== undefined && !positiveInteger(retry.maxAttempts)) {
    throw new Error('retry.maxAttempts must be a positive integer.');
  }
  if (retry.retryDelayMs !== undefined && (!Number.isInteger(retry.retryDelayMs) || retry.retryDelayMs < 0)) {
    throw new Error('retry.retryDelayMs must be a non-negative integer.');
  }
  if (retry.retryExitCodes !== undefined) {
    if (!Array.isArray(retry.retryExitCodes) || retry.retryExitCodes.some((code) => !Number.isInteger(code))) {
      throw new Error('retry.retryExitCodes must be an array of integers.');
    }
  }
}

export function mergeQueueOptions(config, options) {
  const merged = {
    ...config,
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))
  };
  if (!merged.queue) throw new Error('queue command requires --queue or config.queue.');
  merged.queue = normalizeLoopId(merged.queue);
  return merged;
}

async function readQueueLock(root, queue) {
  const lockFile = path.join(queueDirFor(root, queue), 'queue.lock');
  try {
    return await readJson(lockFile);
  } catch {
    return null;
  }
}

async function acquireQueueLock(root, queue, leaseMs) {
  const lockFile = path.join(queueDirFor(root, queue), 'queue.lock');
  const now = Date.now();
  const existing = await readQueueLock(root, queue);
  if (existing && Date.parse(existing.expiresAt) > now) {
    return { acquired: false, lock: existing };
  }
  if (existing) await rm(lockFile, { force: true });
  const lock = {
    version: 1,
    queue,
    pid: process.pid,
    acquiredAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseMs).toISOString()
  };
  let handle = null;
  try {
    handle = await open(lockFile, 'wx');
    await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`);
    return { acquired: true, lock };
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return { acquired: false, lock: await readQueueLock(root, queue) };
    }
    throw err;
  } finally {
    if (handle) await handle.close();
  }
}

async function releaseQueueLock(root, queue, lock) {
  const lockFile = path.join(queueDirFor(root, queue), 'queue.lock');
  const current = await readQueueLock(root, queue);
  if (current?.pid === lock.pid && current?.acquiredAt === lock.acquiredAt) {
    await rm(lockFile, { force: true });
  }
}

async function nextQueuedTaskFile(root, queue) {
  const files = await listJson(queueSubdirFor(root, queue, 'inbox'));
  if (files.length === 0) return null;
  return path.join(queueSubdirFor(root, queue, 'inbox'), files[0]);
}

async function findTaskFile(root, queue, taskId, subdirs = ['inbox', 'active', 'failed', 'done', 'canceled']) {
  const wanted = taskId.endsWith('.json') ? taskId : `${taskId}.json`;
  for (const subdir of subdirs) {
    const file = path.join(queueSubdirFor(root, queue, subdir), wanted);
    if (await exists(file)) return { file, subdir };
  }
  return null;
}

export async function queuePeek(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  await ensureQueueDirs(root, normalized);
  const limit = options.limit ?? 5;
  const files = await listJson(queueSubdirFor(root, normalized, 'inbox'));
  const tasks = [];
  for (const file of files.slice(0, limit)) {
    const full = path.join(queueSubdirFor(root, normalized, 'inbox'), file);
    const task = await readJson(full);
    tasks.push({
      id: task.id,
      title: task.title,
      status: task.status,
      attempts: task.attempts ?? 0,
      enqueuedAt: task.enqueuedAt,
      file: path.relative(root, full)
    });
  }
  return { queue: normalized, tasks };
}

export async function queueCancel(root, queue, taskId, options = {}) {
  const normalized = normalizeLoopId(queue);
  await ensureQueueDirs(root, normalized);
  const found = await findTaskFile(root, normalized, taskId, options.includeActive ? ['inbox', 'active'] : ['inbox']);
  if (!found) throw new Error(`Task not found in cancelable state: ${taskId}`);
  const task = await readJson(found.file);
  const canceledFile = path.join(queueSubdirFor(root, normalized, 'canceled'), path.basename(found.file));
  await writeJson(canceledFile, {
    ...task,
    status: 'canceled',
    canceledAt: new Date().toISOString(),
    canceledFrom: found.subdir,
    cancelReason: options.reason ?? null
  });
  await rm(found.file, { force: true });
  return { queue: normalized, taskId: task.id, from: found.subdir, file: path.relative(root, canceledFile) };
}

export async function queueRequeue(root, queue, taskId, options = {}) {
  const normalized = normalizeLoopId(queue);
  await ensureQueueDirs(root, normalized);
  const found = await findTaskFile(root, normalized, taskId, options.from ? [options.from] : ['failed', 'active', 'canceled']);
  if (!found) throw new Error(`Task not found in requeueable state: ${taskId}`);
  const task = await readJson(found.file);
  const inboxFile = path.join(queueSubdirFor(root, normalized, 'inbox'), path.basename(found.file));
  await writeJson(inboxFile, {
    ...task,
    status: 'queued',
    requeuedAt: new Date().toISOString(),
    requeuedFrom: found.subdir
  });
  await rm(found.file, { force: true });
  return { queue: normalized, taskId: task.id, from: found.subdir, file: path.relative(root, inboxFile) };
}

async function recoverStaleActive(root, queue, staleActiveMs) {
  if (!staleActiveMs) return [];
  const dir = queueSubdirFor(root, queue, 'active');
  const files = await listJson(dir);
  const recovered = [];
  const now = Date.now();
  for (const file of files) {
    const full = path.join(dir, file);
    const s = await stat(full);
    if (now - s.mtimeMs < staleActiveMs) continue;
    const task = await readJson(full);
    const failedFile = path.join(queueSubdirFor(root, queue, 'failed'), file);
    await writeJson(failedFile, {
      ...task,
      status: 'stale_active',
      failedAt: new Date().toISOString(),
      staleActiveMs
    });
    await rm(full, { force: true });
    recovered.push({ taskId: task.id, file: path.relative(root, failedFile) });
  }
  return recovered;
}

function compactCommandResult(result) {
  return {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdout: trimTail(result.stdout),
    stderr: trimTail(result.stderr)
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildQueueEnv(root, queue, task, taskFile, runId) {
  return {
    ...process.env,
    LOOP_QUEUE_ID: queue,
    LOOP_TASK_ID: task.id,
    LOOP_TASK_TITLE: task.title,
    LOOP_TASK_BODY: task.body,
    LOOP_TASK_FILE: taskFile,
    LOOP_TASK_FILE_REL: path.relative(root, taskFile),
    LOOP_RUN_ID: runId
  };
}

function shouldRetryDispatch(result, retry, attempt) {
  const maxAttempts = retry?.maxAttempts ?? 1;
  if (attempt >= maxAttempts) return false;
  if (!result || result.exitCode === 0) return false;
  const retryExitCodes = retry?.retryExitCodes;
  return !retryExitCodes || retryExitCodes.includes(result.exitCode);
}

function delay(ms) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDispatchWithRetry(root, options, queue, task, activeFile, runId, timeoutMs) {
  const attempts = [];
  const retry = options.retry ?? {};
  const maxAttempts = retry.maxAttempts ?? 1;
  const retryDelayMs = retry.retryDelayMs ?? 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = new Date().toISOString();
    const result = await runCommand(options.dispatcher, {
      cwd: root,
      env: {
        ...buildQueueEnv(root, queue, task, activeFile, runId),
        LOOP_ATTEMPT: String(attempt),
        LOOP_MAX_ATTEMPTS: String(maxAttempts)
      },
      timeoutMs
    });
    attempts.push({
      attempt,
      startedAt,
      finishedAt: new Date().toISOString(),
      result
    });
    if (!shouldRetryDispatch(result, retry, attempt)) break;
    await delay(retryDelayMs);
  }
  return attempts;
}

async function runPreflight(root, config, timeoutMs) {
  if (!config) return null;
  const cli = path.join(PACKAGE_ROOT, 'bin', 'loop-engineering.mjs');
  return runCommand(`${shellQuote(process.execPath)} ${shellQuote(cli)} run --config ${shellQuote(config)} --root ${shellQuote(root)} --json`, {
    cwd: root,
    timeoutMs
  });
}

export async function runQueueOnce(root, options) {
  const queue = normalizeLoopId(options.queue);
  await ensureQueueDirs(root, queue);
  if (!options.dispatcher || typeof options.dispatcher !== 'string') {
    throw new Error('run-queue requires --dispatcher.');
  }
  const leaseMs = options.leaseMs ?? options.timeoutMs ?? 30 * 60 * 1000;
  const lockResult = await acquireQueueLock(root, queue, leaseMs);
  if (!lockResult.acquired) {
    return {
      processed: false,
      queue,
      status: 'locked',
      exitCode: 2,
      lock: lockResult.lock ?? null
    };
  }

  try {
    const staleRecovered = await recoverStaleActive(root, queue, options.staleActiveMs);
    const inboxFile = await nextQueuedTaskFile(root, queue);
    if (!inboxFile) {
      return {
        processed: false,
        queue,
        status: 'empty',
        exitCode: 0,
        staleRecovered
      };
    }

    const task = await readJson(inboxFile);
    const activeFile = path.join(queueSubdirFor(root, queue, 'active'), path.basename(inboxFile));
    await rename(inboxFile, activeFile);

    const startedAt = new Date().toISOString();
    const runId = `${isoStamp()}_${task.id}`;
    const runPath = path.join(queueSubdirFor(root, queue, 'runs'), `${runId}.json`);
    const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    let finalStatus = 'unknown';
    let destination = queueSubdirFor(root, queue, 'failed');
    let exitCode = 1;
    let preflight = null;
    let dispatch = null;
    let dispatchAttempts = [];

    try {
      preflight = await runPreflight(root, options.preflightConfig, Math.min(timeoutMs, 3 * 60 * 1000));
      if (preflight && preflight.exitCode !== 0) {
        finalStatus = 'blocked_preflight';
        exitCode = 2;
      } else {
        dispatchAttempts = await runDispatchWithRetry(root, options, queue, task, activeFile, runId, timeoutMs);
        dispatch = dispatchAttempts[dispatchAttempts.length - 1]?.result ?? null;
        finalStatus = dispatch?.exitCode === 0 ? 'completed' : 'failed';
        destination = dispatch?.exitCode === 0
        ? queueSubdirFor(root, queue, 'done')
        : queueSubdirFor(root, queue, 'failed');
        exitCode = dispatch?.exitCode === 0 ? 0 : 1;
      }
    } catch (err) {
      finalStatus = 'runtime_error';
      exitCode = 1;
      dispatch = {
        exitCode: 1,
        timedOut: false,
        stdout: '',
        stderr: err instanceof Error ? err.stack || err.message : String(err)
      };
    }

    const finishedAt = new Date().toISOString();
    const completedTask = {
      ...task,
      status: finalStatus,
      startedAt,
      finishedAt,
      attempts: (task.attempts ?? 0) + Math.max(dispatchAttempts.length, dispatch ? 1 : 0),
      runPath: path.relative(root, runPath)
    };
    const completedFile = path.join(destination, path.basename(activeFile));
    await writeJson(completedFile, completedTask);
    await rm(activeFile, { force: true });

    const run = {
      version: 2,
      runId,
      queue,
      taskId: task.id,
      title: task.title,
      startedAt,
      finishedAt,
      status: finalStatus,
      retry: options.retry ?? null,
      dispatchAttempts: dispatchAttempts.map((attempt) => ({
        attempt: attempt.attempt,
        result: compactCommandResult(attempt.result)
      })),
      preflight: preflight ? compactCommandResult(preflight) : null,
      dispatch: dispatch ? compactCommandResult(dispatch) : null,
      staleRecovered,
      taskPath: path.relative(root, completedFile),
      runPath: path.relative(root, runPath)
    };
    await writeJson(runPath, run);

    if (options.notifyCommand) {
      const detail = dispatch?.stdout || dispatch?.stderr || preflight?.stdout || preflight?.stderr || '';
      const message = [
        `Loop queue task ${finalStatus}: ${task.title}`,
        `queue: ${queue}`,
        `run: ${run.runPath}`,
        trimTail(detail, 1200)
      ].filter(Boolean).join('\n');
      await runCommand(`${options.notifyCommand} ${shellQuote(message)}`, {
        cwd: root,
        timeoutMs: 60 * 1000
      });
    }

    return {
      processed: true,
      queue,
      status: finalStatus,
      exitCode,
      taskPath: path.relative(root, completedFile),
      runPath: path.relative(root, runPath),
      run
    };
  } finally {
    await releaseQueueLock(root, queue, lockResult.lock);
  }
}
