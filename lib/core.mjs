import { access, copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

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
    reason: run.failureSignature
      ?? run.runtimeError
      ?? run.breaker?.reason
      ?? run.verification?.find?.((item) => item.result?.exitCode !== 0)?.result?.stderr?.split('\n').find(Boolean)
      ?? run.dispatch?.stderr?.split('\n').find(Boolean)
      ?? null,
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
      if (optionsForQueue.worktree?.enabled) {
        const cleanup = await codeWorktreeCleanupPlan(root, optionsForQueue.queue, {
          config: optionsForQueue,
          limit: options.limit ?? 10
        });
        if (cleanup.missingWorktrees.length > 0) {
          add(`queue:${optionsForQueue.queue}:worktree-missing`, 'warn', false, cleanup.missingWorktrees);
        }
        if (cleanup.orphanWorktrees.length > 0) {
          add(`queue:${optionsForQueue.queue}:worktree-orphans`, 'warn', false, cleanup.orphanWorktrees);
        }
        if (cleanup.unexportedDirty.length > 0) {
          add(`queue:${optionsForQueue.queue}:worktree-unexported`, 'warn', false, cleanup.unexportedDirty);
        }
        if (cleanup.rejectedPatches.length > 0) {
          add(`queue:${optionsForQueue.queue}:patch-rejected`, 'warn', false, cleanup.rejectedPatches);
        }
      }
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

export async function initCodeQueueConfig(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const templatesDir = path.join(PACKAGE_ROOT, 'templates');
  const configsDir = path.join(root, 'configs', 'loops', 'queues');
  await mkdir(configsDir, { recursive: true });
  await ensureQueueDirs(root, normalized);
  await initWorkspace(root, { force: false });
  const target = path.join(configsDir, `${normalized}.json`);
  if (!(await exists(target)) || options.force) {
    const template = await readJson(path.join(templatesDir, 'code-worktree-queue.json'));
    await writeJson(target, {
      ...template,
      queue: normalized,
      worktree: {
        ...template.worktree,
        baseDir: path.join('runtime', 'loops', normalized, 'worktrees'),
        branchPrefix: `loop/${normalized}`
      }
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
  if (config.worktree !== undefined) validateWorktreeConfig(config.worktree);
  return { ...config, configPath };
}

function validateWorktreeConfig(worktree) {
  if (typeof worktree !== 'object' || worktree === null || Array.isArray(worktree)) {
    throw new Error('queue config worktree must be an object.');
  }
  if (worktree.enabled !== undefined && typeof worktree.enabled !== 'boolean') {
    throw new Error('worktree.enabled must be a boolean.');
  }
  if (worktree.baseDir !== undefined) safeRelativePath(worktree.baseDir, 'worktree baseDir');
  if (worktree.branchPrefix !== undefined && (typeof worktree.branchPrefix !== 'string' || !worktree.branchPrefix.trim())) {
    throw new Error('worktree.branchPrefix must be a non-empty string.');
  }
  if (worktree.keepOnSuccess !== undefined && typeof worktree.keepOnSuccess !== 'boolean') {
    throw new Error('worktree.keepOnSuccess must be a boolean.');
  }
  if (worktree.verifyCommands !== undefined) {
    if (!Array.isArray(worktree.verifyCommands) || worktree.verifyCommands.some((cmd) => typeof cmd !== 'string' || !cmd.trim())) {
      throw new Error('worktree.verifyCommands must be an array of non-empty strings.');
    }
  }
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

function codeWorktreeSummary(entry) {
  const run = entry.run;
  const verifyResults = Array.isArray(run.verification)
    ? run.verification.map((item) => ({
      cmd: item.cmd,
      exitCode: item.result?.exitCode ?? null,
      timedOut: item.result?.timedOut ?? false
    }))
    : [];
  return {
    file: entry.file,
    runId: run.runId ?? null,
    queue: run.queue ?? null,
    taskId: run.taskId ?? null,
    title: run.title ?? null,
    status: run.status ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    taskPath: run.taskPath ?? null,
    worktree: run.worktree ? {
      path: run.worktree.path ?? null,
      branch: run.worktree.branch ?? null,
      head: run.worktree.head ?? null,
      dirty: Boolean(run.worktree.inspection?.dirty),
      setupExitCode: run.worktree.setup?.exitCode ?? null,
      statusShort: run.worktree.inspection?.status?.stdout ?? '',
      diffStat: run.worktree.inspection?.diffStat ?? '',
      diffNameStatus: run.worktree.inspection?.diffNameStatus ?? '',
      untracked: run.worktree.inspection?.untracked ?? ''
    } : null,
    verification: verifyResults,
    verifyOk: verifyResults.every((item) => item.exitCode === 0)
  };
}

export async function codeWorktreeList(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const limit = options.limit ?? 20;
  const entries = (await recentRuns(root, normalized, { limit }))
    .filter((entry) => entry.run?.queue === normalized && entry.run?.worktree);
  return {
    queue: normalized,
    inspectedRuns: entries.length,
    worktrees: entries.map(codeWorktreeSummary).reverse()
  };
}

export async function codeWorktreeInspect(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const found = await findCodeWorktreeRun(root, normalized, options);
  return {
    ...codeWorktreeSummary(found),
    raw: found.run
  };
}

export async function codeWorktreeDiff(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const found = await findCodeWorktreeRun(root, normalized, options);
  const summary = codeWorktreeSummary(found);
  const worktreePath = resolveWorktreePath(root, found.run.worktree?.path);
  if (!(await exists(worktreePath))) {
    throw new Error(`Worktree path no longer exists: ${summary.worktree?.path ?? 'unknown'}`);
  }
  const [diffStat, diffNameStatus, patch, untracked] = await Promise.all([
    runCommand('git diff --stat HEAD', { cwd: worktreePath, timeoutMs: 30000 }),
    runCommand('git diff --name-status HEAD', { cwd: worktreePath, timeoutMs: 30000 }),
    runCommand('git diff --binary HEAD', { cwd: worktreePath, timeoutMs: 30000 }),
    runCommand('git ls-files --others --exclude-standard', { cwd: worktreePath, timeoutMs: 30000 })
  ]);
  for (const [label, result] of Object.entries({ diffStat, diffNameStatus, patch, untracked })) {
    if (result.exitCode !== 0) {
      throw new Error(`Unable to read worktree ${label}: ${trimTail(result.stderr || result.stdout, 1200)}`);
    }
  }
  return {
    ...summary,
    worktreePath,
    diffStat: trimTail(diffStat.stdout, 12000),
    diffNameStatus: trimTail(diffNameStatus.stdout, 12000),
    untracked: trimTail(untracked.stdout, 12000),
    patch: trimTail(patch.stdout, 60000)
  };
}

export async function codeWorktreeExport(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const diff = await codeWorktreeDiff(root, normalized, options);
  const patchFile = resolvePatchOutputPath(root, normalized, diff, options.output);
  if ((await exists(patchFile)) && !options.force) {
    throw new Error(`Patch export already exists: ${path.relative(root, patchFile)}. Use --force to overwrite.`);
  }
  const manifestFile = `${patchFile}.json`;
  const header = [
    `# loop-engineering patch export`,
    `# queue: ${normalized}`,
    `# task: ${diff.taskId ?? 'unknown'}`,
    `# run: ${diff.runId ?? 'unknown'}`,
    `# branch: ${diff.worktree?.branch ?? 'unknown'}`,
    `# worktree: ${diff.worktree?.path ?? 'unknown'}`,
    `# exportedAt: ${new Date().toISOString()}`,
    ''
  ].join('\n');
  const patchBody = diff.patch || '';
  const untrackedBlock = diff.untracked
    ? `\n# Untracked files from worktree:\n${diff.untracked.split('\n').filter(Boolean).map((line) => `#   ${line}`).join('\n')}\n`
    : '';
  const patchContent = `${header}${patchBody}${untrackedBlock}`;
  await mkdir(path.dirname(patchFile), { recursive: true });
  await writeFile(patchFile, patchContent);
  const manifest = {
    version: 1,
    exportedAt: new Date().toISOString(),
    queue: normalized,
    taskId: diff.taskId,
    runId: diff.runId,
    title: diff.title,
    status: diff.status,
    sourceRunFile: diff.file,
    worktree: diff.worktree,
    patchFile: path.relative(root, patchFile),
    patchBytes: Buffer.byteLength(patchContent),
    diffStat: diff.diffStat,
    diffNameStatus: diff.diffNameStatus,
    untracked: diff.untracked
  };
  await writeJson(manifestFile, manifest);
  return {
    ...manifest,
    manifestFile: path.relative(root, manifestFile)
  };
}

export async function codePatchVerify(root, options = {}) {
  if (!options.patch) throw new Error('code-patch-verify requires --patch.');
  const { patchFile, rawPatch, patch, diffFiles } = await loadNormalizedPatch(root, options.patch);
  if (!patch.trim()) {
    return {
      patchFile: path.relative(root, patchFile),
      patchBytes: Buffer.byteLength(rawPatch),
      status: 'empty',
      ok: true,
      diffFiles,
      applyCheck: null
    };
  }

  const applyCheck = await runPatchApplyCheck(root, patch, options.timeoutMs ?? 60000);
  return {
    patchFile: path.relative(root, patchFile),
    patchBytes: Buffer.byteLength(rawPatch),
    normalizedPatchBytes: Buffer.byteLength(patch),
    status: applyCheck.exitCode === 0 ? 'applies' : 'rejected',
    ok: applyCheck.exitCode === 0,
    diffFiles,
    applyCheck: compactCommandResult(applyCheck)
  };
}

export async function codePatchApplyPlan(root, options = {}) {
  if (!options.patch) throw new Error('code-patch-apply-plan requires --patch.');
  const { patchFile, rawPatch, patch, diffFiles } = await loadNormalizedPatch(root, options.patch);
  const affectedPaths = affectedPathsFromDiffFiles(diffFiles);
  const affectedStatus = affectedPaths.length > 0
    ? await gitStatusForPaths(root, affectedPaths, options.timeoutMs ?? 60000)
    : { exitCode: 0, timedOut: false, stdout: '', stderr: '' };
  const dirtyAffected = Boolean(affectedStatus.stdout.trim());
  if (!patch.trim()) {
    return {
      patchFile: path.relative(root, patchFile),
      patchBytes: Buffer.byteLength(rawPatch),
      status: 'empty',
      ok: true,
      canApply: false,
      diffFiles,
      affectedPaths,
      dirtyAffected,
      affectedStatus: compactCommandResult(affectedStatus),
      applyCheck: null
    };
  }

  const applyCheck = await runPatchApplyCheck(root, patch, options.timeoutMs ?? 60000);
  const checkOk = applyCheck.exitCode === 0;
  const canApply = checkOk && (!dirtyAffected || Boolean(options.allowDirty));
  const status = checkOk
    ? dirtyAffected && !options.allowDirty ? 'dirty_affected_files' : 'ready'
    : 'rejected';
  return {
    patchFile: path.relative(root, patchFile),
    patchBytes: Buffer.byteLength(rawPatch),
    normalizedPatchBytes: Buffer.byteLength(patch),
    status,
    ok: canApply,
    canApply,
    allowDirty: Boolean(options.allowDirty),
    diffFiles,
    affectedPaths,
    dirtyAffected,
    affectedStatus: compactCommandResult(affectedStatus),
    applyCheck: compactCommandResult(applyCheck)
  };
}

export async function codePatchApply(root, options = {}) {
  if (!options.confirmApply) {
    throw new Error('code-patch-apply requires --confirm-apply.');
  }
  const { patchFile, rawPatch, patch, diffFiles } = await loadNormalizedPatch(root, options.patch);
  if (!patch.trim()) {
    return {
      patchFile: path.relative(root, patchFile),
      patchBytes: Buffer.byteLength(rawPatch),
      status: 'empty',
      ok: true,
      applied: false,
      diffFiles
    };
  }

  const plan = await codePatchApplyPlan(root, {
    patch: options.patch,
    timeoutMs: options.timeoutMs,
    allowDirty: options.allowDirty
  });
  if (!plan.canApply) {
    return {
      ...plan,
      applied: false,
      status: `not_applied_${plan.status}`
    };
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), 'loop-engineering-patch-'));
  const tempPatch = path.join(tempDir, 'review.patch');
  try {
    await writeFile(tempPatch, patch);
    const apply = await runCommand(`git apply --binary ${shellQuote(tempPatch)}`, {
      cwd: root,
      timeoutMs: options.timeoutMs ?? 60000
    });
    return {
      ...plan,
      status: apply.exitCode === 0 ? 'applied' : 'apply_failed',
      ok: apply.exitCode === 0,
      applied: apply.exitCode === 0,
      appliedAt: apply.exitCode === 0 ? new Date().toISOString() : null,
      apply: compactCommandResult(apply)
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function codeReviewBundle(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const inspected = await codeWorktreeInspect(root, normalized, options);
  const generatedAt = new Date().toISOString();
  const errors = [];
  let diff = null;
  try {
    diff = await codeWorktreeDiff(root, normalized, options);
  } catch (err) {
    errors.push({
      step: 'code-worktree-diff',
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const patchFile = resolvePatchOutputPath(root, normalized, inspected, options.patch);
  const patchRel = path.relative(root, patchFile);
  const patchExists = await exists(patchFile);
  let patchManifest = null;
  let patchVerify = null;
  let applyPlan = null;
  if (patchExists) {
    const manifestFile = `${patchFile}.json`;
    if (await exists(manifestFile)) {
      try {
        patchManifest = await readJson(manifestFile);
      } catch (err) {
        errors.push({
          step: 'read-patch-manifest',
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
    try {
      patchVerify = await codePatchVerify(root, { patch: patchRel, timeoutMs: options.timeoutMs });
    } catch (err) {
      errors.push({
        step: 'code-patch-verify',
        message: err instanceof Error ? err.message : String(err)
      });
    }
    try {
      applyPlan = await codePatchApplyPlan(root, {
        patch: patchRel,
        timeoutMs: options.timeoutMs,
        allowDirty: options.allowDirty
      });
    } catch (err) {
      errors.push({
        step: 'code-patch-apply-plan',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const bundle = {
    version: 1,
    generatedAt,
    queue: normalized,
    taskId: inspected.taskId,
    runId: inspected.runId,
    title: inspected.title,
    status: inspected.status,
    sourceRunFile: inspected.file,
    taskPath: inspected.taskPath,
    worktree: inspected.worktree,
    verification: inspected.verification,
    verifyOk: inspected.verifyOk,
    diff: diff ? {
      diffStat: diff.diffStat,
      diffNameStatus: diff.diffNameStatus,
      untracked: diff.untracked,
      patch: options.includePatch === false ? null : diff.patch
    } : null,
    patchExport: {
      patchFile: patchRel,
      exists: patchExists,
      manifest: patchManifest
    },
    patchVerify,
    applyPlan,
    errors
  };
  const markdown = renderCodeReviewBundleMarkdown(bundle);
  const outputFile = resolveReviewBundleOutputPath(root, normalized, inspected, options.output);
  if ((await exists(outputFile)) && !options.force) {
    throw new Error(`Review bundle already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, markdown);
  const jsonFile = `${outputFile}.json`;
  await writeJson(jsonFile, bundle);
  return {
    ...bundle,
    reviewFile: path.relative(root, outputFile),
    jsonFile: path.relative(root, jsonFile),
    markdown
  };
}

export async function codeTaskCloseout(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const inspected = await codeWorktreeInspect(root, normalized, options);
  const closedAt = new Date().toISOString();
  const errors = [];

  let worktreeFullPath = null;
  let worktreeExists = false;
  try {
    worktreeFullPath = resolveWorktreePath(root, inspected.worktree?.path);
    worktreeExists = await exists(worktreeFullPath);
  } catch (err) {
    errors.push({
      step: 'resolve-worktree',
      message: err instanceof Error ? err.message : String(err)
    });
  }

  let diff = null;
  if (worktreeExists) {
    try {
      diff = await codeWorktreeDiff(root, normalized, options);
    } catch (err) {
      errors.push({
        step: 'code-worktree-diff',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const patchFile = resolvePatchOutputPath(root, normalized, inspected, options.patch);
  const patchRel = path.relative(root, patchFile);
  const patchExists = await exists(patchFile);
  const patchManifestFile = `${patchFile}.json`;
  const patchManifestExists = await exists(patchManifestFile);
  let patchManifest = null;
  let patchVerify = null;
  let applyPlan = null;
  if (patchManifestExists) {
    try {
      patchManifest = await readJson(patchManifestFile);
    } catch (err) {
      errors.push({
        step: 'read-patch-manifest',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }
  if (patchExists) {
    try {
      patchVerify = await codePatchVerify(root, { patch: patchRel, timeoutMs: options.timeoutMs });
    } catch (err) {
      patchVerify = {
        status: 'error',
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
    try {
      applyPlan = await codePatchApplyPlan(root, {
        patch: patchRel,
        timeoutMs: options.timeoutMs,
        allowDirty: options.allowDirty
      });
    } catch (err) {
      applyPlan = {
        status: 'error',
        ok: false,
        canApply: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  const reviewFile = resolveReviewBundleOutputPath(root, normalized, inspected, options.review);
  const reviewRel = path.relative(root, reviewFile);
  const reviewJsonFile = `${reviewFile}.json`;
  const reviewExists = await exists(reviewFile);
  const reviewJsonExists = await exists(reviewJsonFile);
  let reviewJson = null;
  if (reviewJsonExists) {
    try {
      reviewJson = await readJson(reviewJsonFile);
    } catch (err) {
      errors.push({
        step: 'read-review-json',
        message: err instanceof Error ? err.message : String(err)
      });
    }
  }

  let cleanupPlan = null;
  let cleanupItem = null;
  try {
    cleanupPlan = await codeWorktreeCleanupPlan(root, normalized, {
      config: options.config,
      limit: Math.max(options.limit ?? 50, 100)
    });
    cleanupItem = cleanupPlan.worktrees.find((item) => {
      if (inspected.taskId && item.taskId === inspected.taskId) return true;
      if (inspected.runId && item.runId === inspected.runId) return true;
      return false;
    }) ?? null;
  } catch (err) {
    errors.push({
      step: 'code-worktree-cleanup-plan',
      message: err instanceof Error ? err.message : String(err)
    });
  }

  const actions = closeoutActions({
    inspected,
    worktreeExists,
    patchExists,
    patchVerify,
    reviewExists,
    reviewJsonExists,
    cleanupItem
  });
  const closeoutStatus = closeoutStatusFor({
    errors,
    actions,
    worktreeExists,
    patchExists,
    patchVerify,
    reviewExists,
    reviewJsonExists,
    cleanupItem
  });
  const closeout = {
    version: 1,
    closedAt,
    closeoutStatus,
    queue: normalized,
    taskId: inspected.taskId,
    runId: inspected.runId,
    title: inspected.title,
    status: inspected.status,
    sourceRunFile: inspected.file,
    taskPath: inspected.taskPath,
    worktree: inspected.worktree,
    worktreeState: {
      path: inspected.worktree?.path ?? null,
      exists: worktreeExists,
      dirty: Boolean(inspected.worktree?.dirty),
      currentDiffStat: diff?.diffStat ?? null,
      currentDiffNameStatus: diff?.diffNameStatus ?? null,
      currentUntracked: diff?.untracked ?? null
    },
    verification: inspected.verification,
    verifyOk: inspected.verifyOk,
    patchExport: {
      patchFile: patchRel,
      exists: patchExists,
      manifestFile: path.relative(root, patchManifestFile),
      manifestExists: patchManifestExists,
      manifest: patchManifest
    },
    patchVerify,
    applyPlan,
    review: {
      reviewFile: reviewRel,
      exists: reviewExists,
      jsonFile: path.relative(root, reviewJsonFile),
      jsonExists: reviewJsonExists,
      json: reviewJson
    },
    cleanup: {
      recommendation: cleanupItem?.recommendation ?? null,
      exists: cleanupItem?.exists ?? worktreeExists,
      patchStatus: cleanupItem?.patchVerify?.status ?? null,
      commands: cleanupItem?.recommendedCommands ?? [],
      skippedReason: cleanupItem ? null : 'not_found_in_cleanup_plan'
    },
    actions,
    errors
  };

  const markdown = renderCodeTaskCloseoutMarkdown(closeout);
  const outputFile = resolveCloseoutOutputPath(root, normalized, inspected, options.output);
  if ((await exists(outputFile)) && !options.force) {
    throw new Error(`Closeout artifact already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, markdown);
  const jsonFile = `${outputFile}.json`;
  await writeJson(jsonFile, closeout);
  return {
    ...closeout,
    closeoutFile: path.relative(root, outputFile),
    jsonFile: path.relative(root, jsonFile),
    markdown
  };
}

export async function codeTaskAutoflow(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const until = normalizeAutoflowUntil(options.until ?? 'review');
  const inspected = await codeWorktreeInspect(root, normalized, options);
  const startedAt = new Date().toISOString();
  const idOptions = {
    taskId: options.taskId,
    runId: options.runId,
    limit: options.limit
  };
  const steps = [];
  const errors = [];

  const patchFile = resolvePatchOutputPath(root, normalized, inspected, options.patch);
  const patchRel = path.relative(root, patchFile);
  const patchManifestRel = path.relative(root, `${patchFile}.json`);
  const reviewFile = resolveReviewBundleOutputPath(root, normalized, inspected, options.review);
  const reviewRel = path.relative(root, reviewFile);
  const reviewJsonRel = path.relative(root, `${reviewFile}.json`);
  const closeoutFile = resolveCloseoutOutputPath(root, normalized, inspected, options.closeout);
  const closeoutRel = path.relative(root, closeoutFile);
  const closeoutJsonRel = path.relative(root, `${closeoutFile}.json`);

  let patchExport = null;
  let patchVerify = null;
  let applyPlan = null;
  let review = null;
  let closeout = null;

  if (stageAtLeast(until, 'export')) {
    try {
      if ((await exists(patchFile)) && (await exists(`${patchFile}.json`)) && !options.force) {
        patchExport = {
          status: 'skipped_exists',
          patchFile: patchRel,
          manifestFile: patchManifestRel
        };
      } else {
        patchExport = await codeWorktreeExport(root, normalized, {
          ...idOptions,
          output: options.patch,
          force: options.force
        });
      }
      steps.push({
        name: 'export',
        status: patchExport.status ?? 'created',
        artifact: patchExport.patchFile,
        sidecar: patchExport.manifestFile
      });
    } catch (err) {
      errors.push(stepError('export', err));
      steps.push({ name: 'export', status: 'error' });
    }
  }

  if (stageAtLeast(until, 'verify') && await exists(patchFile)) {
    try {
      patchVerify = await codePatchVerify(root, {
        patch: patchRel,
        timeoutMs: options.timeoutMs
      });
      steps.push({
        name: 'verify',
        status: patchVerify.status,
        ok: patchVerify.ok,
        artifact: patchVerify.patchFile
      });
    } catch (err) {
      errors.push(stepError('verify', err));
      steps.push({ name: 'verify', status: 'error' });
    }
  }

  if (stageAtLeast(until, 'plan') && await exists(patchFile)) {
    try {
      applyPlan = await codePatchApplyPlan(root, {
        patch: patchRel,
        timeoutMs: options.timeoutMs,
        allowDirty: options.allowDirty
      });
      steps.push({
        name: 'apply-plan',
        status: applyPlan.status,
        ok: applyPlan.ok,
        canApply: applyPlan.canApply,
        artifact: applyPlan.patchFile
      });
    } catch (err) {
      errors.push(stepError('apply-plan', err));
      steps.push({ name: 'apply-plan', status: 'error' });
    }
  }

  if (stageAtLeast(until, 'review')) {
    try {
      if ((await exists(reviewFile)) && (await exists(`${reviewFile}.json`)) && !options.force) {
        review = {
          status: 'skipped_exists',
          reviewFile: reviewRel,
          jsonFile: reviewJsonRel
        };
      } else {
        review = await codeReviewBundle(root, normalized, {
          ...idOptions,
          output: options.review,
          force: options.force,
          timeoutMs: options.timeoutMs,
          allowDirty: options.allowDirty
        });
      }
      steps.push({
        name: 'review',
        status: review.status ?? 'created',
        artifact: review.reviewFile,
        sidecar: review.jsonFile
      });
    } catch (err) {
      errors.push(stepError('review', err));
      steps.push({ name: 'review', status: 'error' });
    }
  }

  if (stageAtLeast(until, 'closeout')) {
    try {
      if ((await exists(closeoutFile)) && (await exists(`${closeoutFile}.json`)) && !options.force) {
        closeout = {
          closeoutStatus: 'skipped_exists',
          closeoutFile: closeoutRel,
          jsonFile: closeoutJsonRel
        };
      } else {
        closeout = await codeTaskCloseout(root, normalized, {
          ...idOptions,
          config: options.config,
          output: options.closeout,
          force: options.force,
          timeoutMs: options.timeoutMs,
          allowDirty: options.allowDirty
        });
      }
      steps.push({
        name: 'closeout',
        status: closeout.closeoutStatus ?? closeout.status ?? 'created',
        artifact: closeout.closeoutFile,
        sidecar: closeout.jsonFile
      });
    } catch (err) {
      errors.push(stepError('closeout', err));
      steps.push({ name: 'closeout', status: 'error' });
    }
  }

  return {
    version: 1,
    queue: normalized,
    taskId: inspected.taskId,
    runId: inspected.runId,
    title: inspected.title,
    sourceRunFile: inspected.file,
    startedAt,
    finishedAt: new Date().toISOString(),
    until,
    ok: errors.length === 0,
    status: errors.length === 0 ? 'completed' : 'needs_attention',
    safety: {
      appliedPatch: false,
      cleanedWorktree: false,
      changedQueueState: false,
      stagedCommittedPushedOrMerged: false
    },
    artifacts: {
      patchFile: patchRel,
      patchManifestFile: patchManifestRel,
      reviewFile: reviewRel,
      reviewJsonFile: reviewJsonRel,
      closeoutFile: closeoutRel,
      closeoutJsonFile: closeoutJsonRel
    },
    patchExport,
    patchVerify,
    applyPlan,
    review: review ? stripLargeMarkdown(review) : null,
    closeout: closeout ? stripLargeMarkdown(closeout) : null,
    steps,
    errors
  };
}

export async function codeTaskFinish(root, queue, options = {}) {
  if (!options.confirmApply) {
    throw new Error('code-task-finish requires --confirm-apply.');
  }
  if (!options.confirmCleanup) {
    throw new Error('code-task-finish requires --confirm-cleanup.');
  }
  const normalized = normalizeLoopId(queue);
  const inspected = await codeWorktreeInspect(root, normalized, options);
  const startedAt = new Date().toISOString();
  const errors = [];
  const steps = [];

  const patchFile = resolvePatchOutputPath(root, normalized, inspected, options.patch);
  const patchRel = path.relative(root, patchFile);
  const patchExists = await exists(patchFile);
  const patchManifestExists = await exists(`${patchFile}.json`);
  const reviewFile = resolveReviewBundleOutputPath(root, normalized, inspected, options.review);
  const reviewRel = path.relative(root, reviewFile);
  const reviewExists = await exists(reviewFile);
  const reviewJsonExists = await exists(`${reviewFile}.json`);
  const closeoutFile = resolveCloseoutOutputPath(root, normalized, inspected, options.closeout);
  const closeoutRel = path.relative(root, closeoutFile);
  const closeoutExists = await exists(closeoutFile);
  const closeoutJsonExists = await exists(`${closeoutFile}.json`);

  if (!patchExists) errors.push({ step: 'gate', message: `Default patch export is missing: ${patchRel}` });
  if (!patchManifestExists) errors.push({ step: 'gate', message: `Default patch manifest is missing: ${patchRel}.json` });
  if (!reviewExists || !reviewJsonExists) errors.push({ step: 'gate', message: `Review bundle is incomplete: ${reviewRel}` });
  if (!closeoutExists || !closeoutJsonExists) errors.push({ step: 'gate', message: `Closeout artifact is incomplete: ${closeoutRel}` });

  let applyPlan = null;
  if (patchExists) {
    try {
      applyPlan = await codePatchApplyPlan(root, {
        patch: patchRel,
        timeoutMs: options.timeoutMs,
        allowDirty: options.allowDirty
      });
      steps.push({
        name: 'apply-plan',
        status: applyPlan.status,
        ok: applyPlan.ok,
        canApply: applyPlan.canApply
      });
      if (!applyPlan.canApply) {
        errors.push({ step: 'apply-plan', message: `Patch is not ready to apply: ${applyPlan.status}` });
      }
    } catch (err) {
      errors.push(stepError('apply-plan', err));
      steps.push({ name: 'apply-plan', status: 'error' });
    }
  }

  let cleanupItem = null;
  let cleanupGateResult = null;
  try {
    const cleanupPlan = await codeWorktreeCleanupPlan(root, normalized, {
      config: options.config,
      limit: Math.max(options.limit ?? 50, 100)
    });
    cleanupItem = cleanupPlan.worktrees.find((item) => {
      if (inspected.taskId && item.taskId === inspected.taskId) return true;
      if (inspected.runId && item.runId === inspected.runId) return true;
      return false;
    }) ?? null;
    if (!cleanupItem) {
      errors.push({ step: 'cleanup-gate', message: 'Task was not found in cleanup plan.' });
      cleanupGateResult = { ok: false, reason: 'not_found_in_cleanup_plan' };
    } else {
      cleanupGateResult = await cleanupGate(root, normalized, cleanupItem);
      steps.push({
        name: 'cleanup-gate',
        status: cleanupGateResult.ok ? 'ready' : 'blocked',
        ok: cleanupGateResult.ok,
        reason: cleanupGateResult.reason
      });
      if (!cleanupGateResult.ok) {
        errors.push({ step: 'cleanup-gate', message: cleanupGateResult.reason });
      }
    }
  } catch (err) {
    errors.push(stepError('cleanup-gate', err));
    steps.push({ name: 'cleanup-gate', status: 'error' });
  }

  let patchApply = null;
  let cleanup = null;
  if (errors.length === 0) {
    patchApply = await codePatchApply(root, {
      patch: patchRel,
      timeoutMs: options.timeoutMs,
      allowDirty: options.allowDirty,
      confirmApply: true
    });
    steps.push({
      name: 'apply',
      status: patchApply.status,
      ok: patchApply.ok,
      applied: patchApply.applied
    });
    if (!patchApply.applied) {
      errors.push({ step: 'apply', message: `Patch was not applied: ${patchApply.status}` });
    }
  }

  if (errors.length === 0 && cleanupItem) {
    const full = resolveWorktreePath(root, cleanupItem.worktree.path);
    const forceFlag = cleanupItem.worktree?.dirty ? ' --force' : '';
    const remove = await runCommand(`git worktree remove${forceFlag} ${shellQuote(full)}`, {
      cwd: root,
      timeoutMs: options.timeoutMs ?? 120000
    });
    cleanup = {
      worktree: cleanupItem.worktree?.path ?? null,
      branch: cleanupItem.worktree?.branch ?? null,
      recommendation: cleanupItem.recommendation,
      removed: remove.exitCode === 0,
      remove: compactCommandResult(remove)
    };
    steps.push({
      name: 'cleanup',
      status: cleanup.removed ? 'removed' : 'remove_failed',
      ok: cleanup.removed
    });
    if (!cleanup.removed) {
      errors.push({ step: 'cleanup', message: 'git worktree remove failed' });
    }
  }

  const finish = {
    version: 1,
    queue: normalized,
    taskId: inspected.taskId,
    runId: inspected.runId,
    title: inspected.title,
    sourceRunFile: inspected.file,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: errors.length === 0 ? 'finished' : 'needs_attention',
    ok: errors.length === 0,
    artifacts: {
      patchFile: patchRel,
      patchManifestFile: `${patchRel}.json`,
      reviewFile: reviewRel,
      reviewJsonFile: `${reviewRel}.json`,
      closeoutFile: closeoutRel,
      closeoutJsonFile: `${closeoutRel}.json`
    },
    gates: {
      patchExists,
      patchManifestExists,
      reviewExists,
      reviewJsonExists,
      closeoutExists,
      closeoutJsonExists,
      applyPlan,
      cleanupGate: cleanupGateResult
    },
    patchApply,
    cleanup,
    steps,
    errors,
    safety: {
      requiredConfirmApply: true,
      requiredConfirmCleanup: true,
      appliedPatch: Boolean(patchApply?.applied),
      cleanedWorktree: Boolean(cleanup?.removed),
      changedQueueState: false,
      stagedCommittedPushedOrMerged: false,
      deletedBranch: false
    }
  };

  const outputFile = resolveFinishOutputPath(root, normalized, inspected, options.output);
  if ((await exists(outputFile)) && !options.force) {
    throw new Error(`Finish artifact already exists: ${path.relative(root, outputFile)}. Use --force to overwrite.`);
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, renderCodeTaskFinishMarkdown(finish));
  const jsonFile = `${outputFile}.json`;
  await writeJson(jsonFile, finish);
  return {
    ...finish,
    finishFile: path.relative(root, outputFile),
    jsonFile: path.relative(root, jsonFile)
  };
}

export async function codeTaskAutoflowBatch(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  if (options.patch || options.review || options.closeout) {
    throw new Error('code-task-autoflow --all-actionable does not support custom output paths.');
  }
  const until = normalizeAutoflowUntil(options.until ?? 'review');
  const status = await codeTaskStatus(root, normalized, {
    config: options.config,
    limit: options.limit ?? 20
  });
  const candidates = status.tasks.filter((task) => taskAutoflowActionable(task, until));
  const results = [];
  for (const task of candidates) {
    try {
      results.push(await codeTaskAutoflow(root, normalized, {
        config: options.config,
        taskId: task.taskId,
        runId: task.taskId ? undefined : task.runId,
        limit: options.lookupLimit,
        until,
        force: options.force,
        timeoutMs: options.timeoutMs,
        allowDirty: options.allowDirty
      }));
    } catch (err) {
      results.push({
        version: 1,
        queue: normalized,
        taskId: task.taskId,
        runId: task.runId,
        title: task.title,
        until,
        ok: false,
        status: 'needs_attention',
        steps: [],
        errors: [stepError('autoflow', err)]
      });
    }
  }
  const counts = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return {
    version: 1,
    queue: normalized,
    generatedAt: new Date().toISOString(),
    until,
    inspectedTasks: status.tasks.length,
    candidateTasks: candidates.length,
    ok: results.every((result) => result.ok),
    status: results.every((result) => result.ok) ? 'completed' : 'needs_attention',
    counts,
    safety: {
      appliedPatch: false,
      cleanedWorktree: false,
      changedQueueState: false,
      stagedCommittedPushedOrMerged: false
    },
    skipped: status.tasks
      .filter((task) => !candidates.includes(task))
      .map((task) => ({
        taskId: task.taskId,
        runId: task.runId,
        overallStatus: task.overallStatus,
        reason: 'not_actionable_for_autoflow'
      })),
    results
  };
}

export async function codeTaskStatus(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const limit = options.limit ?? 20;
  const entries = (await recentRuns(root, normalized, { limit: Math.max(limit, 100) }))
    .filter((entry) => entry.run?.queue === normalized && entry.run?.worktree)
    .reverse()
    .filter((entry) => {
      if (options.runId && entry.run.runId !== options.runId) return false;
      if (options.taskId && entry.run.taskId !== options.taskId) return false;
      return true;
    })
    .slice(0, limit);

  let cleanupPlan = null;
  let cleanupError = null;
  try {
    cleanupPlan = await codeWorktreeCleanupPlan(root, normalized, {
      config: options.config,
      limit: Math.max(limit, 100)
    });
  } catch (err) {
    cleanupError = err instanceof Error ? err.message : String(err);
  }

  const tasks = [];
  for (const entry of entries) {
    const summary = codeWorktreeSummary(entry);
    const cleanupItem = cleanupPlan?.worktrees.find((item) => {
      if (summary.taskId && item.taskId === summary.taskId) return true;
      if (summary.runId && item.runId === summary.runId) return true;
      return false;
    }) ?? null;
    tasks.push(await codeTaskLedgerItem(root, normalized, summary, cleanupItem));
  }

  const counts = {};
  for (const task of tasks) counts[task.overallStatus] = (counts[task.overallStatus] ?? 0) + 1;
  return {
    version: 1,
    queue: normalized,
    generatedAt: new Date().toISOString(),
    inspectedRuns: entries.length,
    cleanupPlanError: cleanupError,
    counts,
    tasks
  };
}

export async function codeTaskDashboard(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const limit = options.limit ?? 20;
  const [queueSummary, taskStatus, cleanupPlan] = await Promise.all([
    queueStatus(root, normalized),
    codeTaskStatus(root, normalized, {
      config: options.config,
      limit
    }),
    codeWorktreeCleanupPlan(root, normalized, {
      config: options.config,
      limit: Math.max(limit, 50)
    })
  ]);

  const buckets = {
    needsPatchExport: [],
    needsReview: [],
    needsCloseout: [],
    readyToFinish: [],
    needsCleanup: [],
    blocked: [],
    ready: [],
    closed: [],
    landed: []
  };
  const actionCounts = {
    patchExport: 0,
    reviewBundle: 0,
    closeout: 0,
    finish: 0,
    cleanup: 0,
    manualReview: 0
  };

  for (const task of taskStatus.tasks) {
    const compact = compactDashboardTask(task);
    if (task.overallStatus === 'needs_patch_export') buckets.needsPatchExport.push(compact);
    else if (task.overallStatus === 'needs_review') buckets.needsReview.push(compact);
    else if (task.overallStatus === 'needs_closeout') buckets.needsCloseout.push(compact);
    else if (task.overallStatus === 'ready_to_finish') buckets.readyToFinish.push(compact);
    else if (task.overallStatus === 'needs_cleanup') buckets.needsCleanup.push(compact);
    else if (String(task.overallStatus ?? '').startsWith('blocked_')) buckets.blocked.push(compact);
    else if (task.overallStatus === 'landed') buckets.landed.push(compact);
    else if (task.overallStatus === 'closed') buckets.closed.push(compact);
    else buckets.ready.push(compact);

    for (const action of task.nextActions ?? []) {
      if (action.includes('code-worktree-export')) actionCounts.patchExport += 1;
      else if (action.includes('code-review-bundle')) actionCounts.reviewBundle += 1;
      else if (action.includes('code-task-closeout')) actionCounts.closeout += 1;
      else if (action.includes('code-task-finish')) actionCounts.finish += 1;
      else if (action.includes('code-worktree-cleanup')) actionCounts.cleanup += 1;
      else actionCounts.manualReview += 1;
    }
  }

  const priority = [
    ...buckets.blocked,
    ...buckets.needsPatchExport,
    ...buckets.needsReview,
    ...buckets.needsCloseout,
    ...buckets.readyToFinish,
    ...buckets.needsCleanup
  ];
  const recommendedCommands = [];
  if (buckets.needsPatchExport.length > 0 || buckets.needsReview.length > 0) {
    recommendedCommands.push(`loop-engineering code-task-autoflow --queue ${normalized} --all-actionable`);
  }
  if (buckets.needsCloseout.length > 0) {
    recommendedCommands.push(`loop-engineering code-task-autoflow --queue ${normalized} --all-actionable --until closeout`);
  }
  if (buckets.readyToFinish.length > 0) {
    recommendedCommands.push('Review ready_to_finish tasks individually, then run code-task-finish with --confirm-apply --confirm-cleanup for one task at a time.');
  }
  if (buckets.needsCleanup.length > 0 || cleanupPlan.orphanWorktrees.length > 0) {
    recommendedCommands.push(`loop-engineering code-worktree-cleanup-plan --queue ${normalized}`);
  }

  return {
    version: 1,
    queue: normalized,
    generatedAt: new Date().toISOString(),
    queueSummary,
    taskSummary: {
      inspectedRuns: taskStatus.inspectedRuns,
      counts: taskStatus.counts,
      cleanupPlanError: taskStatus.cleanupPlanError
    },
    actionCounts,
    cleanupSummary: {
      cleanupCandidates: cleanupPlan.cleanupCandidates.length,
      unexportedDirty: cleanupPlan.unexportedDirty.length,
      rejectedPatches: cleanupPlan.rejectedPatches.length,
      missingWorktrees: cleanupPlan.missingWorktrees.length,
      orphanWorktrees: cleanupPlan.orphanWorktrees.length
    },
    buckets,
    priority,
    recommendedCommands,
    safety: {
      readOnly: true,
      appliedPatch: false,
      cleanedWorktree: false,
      changedQueueState: false,
      stagedCommittedPushedOrMerged: false
    }
  };
}

export async function codeWorktreeCleanupPlan(root, queue, options = {}) {
  const normalized = normalizeLoopId(queue);
  const limit = options.limit ?? 50;
  const allEntries = (await recentRuns(root, normalized, { limit: Math.max(limit, 1000) }))
    .filter((entry) => entry.run?.queue === normalized && entry.run?.worktree)
    .reverse();
  const entries = allEntries.slice(0, limit);
  const worktrees = [];
  const referencedRelPaths = new Set();
  for (const entry of allEntries) {
    try {
      referencedRelPaths.add(path.relative(root, resolveWorktreePath(root, entry.run.worktree?.path)));
    } catch {
      // Unsafe recorded paths are reported on inspected entries; they should not
      // suppress orphan detection for real directories.
    }
  }
  for (const entry of entries) {
    const summary = codeWorktreeSummary(entry);
    const recordedPath = entry.run.worktree?.path ?? null;
    const item = {
      file: entry.file,
      runId: summary.runId,
      taskId: summary.taskId,
      title: summary.title,
      status: summary.status,
      finishedAt: summary.finishedAt,
      worktree: summary.worktree,
      exists: false,
      pathSafe: false,
      exportedPatchFile: null,
      exportedManifestFile: null,
      patchVerify: null,
      recommendation: 'inspect',
      recommendedCommands: []
    };
    try {
      const full = resolveWorktreePath(root, recordedPath);
      const rel = path.relative(root, full);
      item.pathSafe = true;
      item.exists = await exists(full);
    } catch (err) {
      item.recommendation = 'unsafe_path';
      item.pathError = err instanceof Error ? err.message : String(err);
      worktrees.push(item);
      continue;
    }

    const patchFile = resolvePatchOutputPath(root, normalized, summary, null);
    const manifestFile = `${patchFile}.json`;
    if (await exists(patchFile)) item.exportedPatchFile = path.relative(root, patchFile);
    if (await exists(manifestFile)) item.exportedManifestFile = path.relative(root, manifestFile);
    if (item.exportedPatchFile) {
      try {
        item.patchVerify = await codePatchVerify(root, { patch: item.exportedPatchFile });
      } catch (err) {
        item.patchVerify = {
          status: 'error',
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        };
      }
    }

    if (!item.exists) {
      item.recommendation = 'missing_worktree';
    } else if (summary.worktree?.dirty && !item.exportedPatchFile) {
      item.recommendation = 'export_before_cleanup';
      item.recommendedCommands.push(`loop-engineering code-worktree-export --root ${shellQuote(root)} --queue ${normalized} --task-id ${summary.taskId}`);
    } else if (summary.worktree?.dirty && item.patchVerify?.ok) {
      item.recommendation = 'review_then_cleanup';
      item.recommendedCommands.push(`git -C ${shellQuote(root)} worktree remove --force ${shellQuote(resolveWorktreePath(root, recordedPath))}`);
    } else if (summary.worktree?.dirty && item.patchVerify && !item.patchVerify.ok) {
      item.recommendation = 'patch_rejected_review_worktree';
    } else {
      item.recommendation = 'cleanup_candidate';
      item.recommendedCommands.push(`git -C ${shellQuote(root)} worktree remove ${shellQuote(resolveWorktreePath(root, recordedPath))}`);
    }
    worktrees.push(item);
  }

  const orphanWorktrees = await listOrphanWorktrees(root, normalized, options.config, referencedRelPaths);
  const missingWorktrees = worktrees
    .filter((item) => item.recommendation === 'missing_worktree')
    .map(compactCleanupItem);
  const unexportedDirty = worktrees
    .filter((item) => item.recommendation === 'export_before_cleanup')
    .map(compactCleanupItem);
  const rejectedPatches = worktrees
    .filter((item) => item.recommendation === 'patch_rejected_review_worktree')
    .map(compactCleanupItem);
  const cleanupCandidates = worktrees
    .filter((item) => ['cleanup_candidate', 'review_then_cleanup'].includes(item.recommendation))
    .map(compactCleanupItem);
  return {
    version: 1,
    queue: normalized,
    generatedAt: new Date().toISOString(),
    inspectedRuns: entries.length,
    cleanupCandidates,
    missingWorktrees,
    unexportedDirty,
    rejectedPatches,
    orphanWorktrees,
    worktrees
  };
}

function compactDashboardTask(task) {
  return {
    taskId: task.taskId,
    runId: task.runId,
    title: task.title,
    overallStatus: task.overallStatus,
    taskState: task.taskState,
    finishedAt: task.finishedAt,
    verifyOk: task.verifyOk,
    worktree: {
      exists: task.worktree?.exists ?? false,
      dirty: task.worktree?.dirty ?? false,
      path: task.worktree?.path ?? null
    },
    patch: {
      exists: task.patch?.exists ?? false,
      verifyStatus: task.patch?.verifyStatus ?? null
    },
    review: {
      exists: task.review?.exists ?? false
    },
    closeout: {
      exists: task.closeout?.exists ?? false,
      status: task.closeout?.status ?? null
    },
    finish: {
      exists: task.finish?.exists ?? false,
      status: task.finish?.status ?? null
    },
    cleanup: {
      recommendation: task.cleanup?.recommendation ?? null
    },
    nextActions: task.nextActions ?? []
  };
}

export async function codeWorktreeCleanup(root, queue, options = {}) {
  if (!options.confirmCleanup) {
    throw new Error('code-worktree-cleanup requires --confirm-cleanup.');
  }
  const normalized = normalizeLoopId(queue);
  const plan = await codeWorktreeCleanupPlan(root, normalized, options);
  const removedWorktrees = [];
  const removedOrphans = [];
  const skipped = [];

  for (const item of plan.worktrees) {
    const gate = await cleanupGate(root, normalized, item);
    if (!gate.ok) {
      skipped.push({
        taskId: item.taskId,
        runId: item.runId,
        worktree: item.worktree?.path ?? null,
        recommendation: item.recommendation,
        reason: gate.reason
      });
      continue;
    }
    const full = resolveWorktreePath(root, item.worktree.path);
    const forceFlag = item.worktree?.dirty ? ' --force' : '';
    const remove = await runCommand(`git worktree remove${forceFlag} ${shellQuote(full)}`, {
      cwd: root,
      timeoutMs: options.timeoutMs ?? 120000
    });
    const removed = remove.exitCode === 0;
    if (!removed) {
      skipped.push({
        taskId: item.taskId,
        runId: item.runId,
        worktree: item.worktree?.path ?? null,
        recommendation: item.recommendation,
        reason: 'git_worktree_remove_failed',
        remove: compactCommandResult(remove)
      });
      continue;
    }
    removedWorktrees.push({
      taskId: item.taskId,
      runId: item.runId,
      worktree: item.worktree?.path ?? null,
      branch: item.worktree?.branch ?? null,
      recommendation: item.recommendation,
      remove: compactCommandResult(remove)
    });
  }

  if (options.includeOrphans) {
    for (const orphan of plan.orphanWorktrees) {
      const full = path.join(root, safeRelativePath(orphan.path, 'orphan worktree path'));
      const remove = await runCommand(`git worktree remove ${shellQuote(full)}`, {
        cwd: root,
        timeoutMs: options.timeoutMs ?? 120000
      });
      if (remove.exitCode === 0) {
        removedOrphans.push({
          path: orphan.path,
          remove: compactCommandResult(remove)
        });
      } else {
        skipped.push({
          path: orphan.path,
          recommendation: 'orphan_worktree',
          reason: 'git_worktree_remove_failed',
          remove: compactCommandResult(remove)
        });
      }
    }
  } else {
    for (const orphan of plan.orphanWorktrees) {
      skipped.push({
        path: orphan.path,
        recommendation: 'orphan_worktree',
        reason: 'include_orphans_not_set'
      });
    }
  }

  const failedSkips = skipped.filter((item) => item.reason === 'git_worktree_remove_failed');
  return {
    version: 1,
    queue: normalized,
    cleanedAt: new Date().toISOString(),
    status: failedSkips.length > 0 ? 'partial' : 'completed',
    ok: failedSkips.length === 0,
    planGeneratedAt: plan.generatedAt,
    removedWorktrees,
    removedOrphans,
    skipped
  };
}

async function cleanupGate(root, queue, item) {
  if (!['cleanup_candidate', 'review_then_cleanup'].includes(item.recommendation)) {
    return { ok: false, reason: `not_cleanup_candidate:${item.recommendation}` };
  }
  if (!item.exists) return { ok: false, reason: 'worktree_missing' };
  if (!item.pathSafe) return { ok: false, reason: 'unsafe_worktree_path' };
  if (!item.worktree?.path) return { ok: false, reason: 'missing_worktree_path' };
  if (item.worktree?.dirty) {
    if (!item.exportedPatchFile) return { ok: false, reason: 'dirty_without_exported_patch' };
    if (!item.patchVerify?.ok) return { ok: false, reason: 'dirty_patch_not_verified' };
    const reviewFile = resolveReviewBundleOutputPath(root, queue, item, null);
    if (!(await exists(reviewFile))) return { ok: false, reason: 'dirty_without_review_bundle' };
    const reviewJson = `${reviewFile}.json`;
    if (!(await exists(reviewJson))) return { ok: false, reason: 'dirty_without_review_json' };
  }
  return { ok: true, reason: null };
}

function compactCleanupItem(item) {
  return {
    taskId: item.taskId,
    runId: item.runId,
    status: item.status,
    worktree: item.worktree?.path ?? null,
    exportedPatchFile: item.exportedPatchFile,
    patchStatus: item.patchVerify?.status ?? null,
    recommendation: item.recommendation,
    commands: item.recommendedCommands
  };
}

async function listOrphanWorktrees(root, queue, config = {}, referencedRelPaths = new Set()) {
  const baseRel = safeRelativePath(config.worktree?.baseDir ?? path.join('runtime', 'loops', queue, 'worktrees'), 'worktree baseDir');
  const baseDir = path.join(root, baseRel);
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const orphans = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(baseDir, entry.name);
      const rel = path.relative(root, full);
      if (!referencedRelPaths.has(rel)) {
        orphans.push({
          path: rel,
          command: `git -C ${shellQuote(root)} worktree remove ${shellQuote(full)}`
        });
      }
    }
    return orphans;
  } catch {
    return [];
  }
}

function extractGitPatch(rawPatch) {
  const lines = rawPatch.split('\n');
  const start = lines.findIndex((line) => line.startsWith('diff --git '));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === '# Untracked files from worktree:') {
      end = i;
      break;
    }
  }
  return `${lines.slice(start, end).join('\n').trimEnd()}\n`;
}

async function loadNormalizedPatch(root, patch) {
  const patchFile = path.resolve(root, safeRelativePath(patch, 'patch file'));
  if (!(await exists(patchFile))) {
    throw new Error(`Patch file does not exist: ${path.relative(root, patchFile)}`);
  }
  const rawPatch = await readFile(patchFile, 'utf8');
  const normalizedPatch = extractGitPatch(rawPatch);
  return {
    patchFile,
    rawPatch,
    patch: normalizedPatch,
    diffFiles: diffFilesFromPatch(normalizedPatch)
  };
}

async function runPatchApplyCheck(root, patch, timeoutMs) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'loop-engineering-patch-'));
  const tempPatch = path.join(tempDir, 'review.patch');
  try {
    await writeFile(tempPatch, patch);
    return await runCommand(`git apply --check --binary ${shellQuote(tempPatch)}`, {
      cwd: root,
      timeoutMs
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function diffFilesFromPatch(patch) {
  const files = [];
  for (const line of patch.split('\n')) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) files.push({ oldPath: match[1], newPath: match[2] });
  }
  return files;
}

function affectedPathsFromDiffFiles(diffFiles) {
  const paths = new Set();
  for (const file of diffFiles) {
    for (const candidate of [file.oldPath, file.newPath]) {
      if (!candidate || candidate === '/dev/null') continue;
      paths.add(candidate);
    }
  }
  return [...paths].sort();
}

async function gitStatusForPaths(root, paths, timeoutMs) {
  const args = paths.map((p) => safeRelativePath(p, 'patch path')).map(shellQuote).join(' ');
  return runCommand(`git status --short -- ${args}`, {
    cwd: root,
    timeoutMs
  });
}

function resolvePatchOutputPath(root, queue, diff, output) {
  if (output) {
    return path.resolve(root, safeRelativePath(output, 'patch output'));
  }
  const fileBase = `${sanitizeFileSegment(diff.taskId ?? diff.runId ?? 'worktree')}.patch`;
  return path.join(queueSubdirFor(root, queue, 'patches'), fileBase);
}

function resolveReviewBundleOutputPath(root, queue, summary, output) {
  if (output) {
    return path.resolve(root, safeRelativePath(output, 'review output'));
  }
  const fileBase = `${sanitizeFileSegment(summary.taskId ?? summary.runId ?? 'worktree')}.md`;
  return path.join(queueSubdirFor(root, queue, 'reviews'), fileBase);
}

function resolveCloseoutOutputPath(root, queue, summary, output) {
  if (output) {
    return path.resolve(root, safeRelativePath(output, 'closeout output'));
  }
  const fileBase = `${sanitizeFileSegment(summary.taskId ?? summary.runId ?? 'worktree')}.md`;
  return path.join(queueSubdirFor(root, queue, 'closeouts'), fileBase);
}

function resolveFinishOutputPath(root, queue, summary, output) {
  if (output) {
    return path.resolve(root, safeRelativePath(output, 'finish output'));
  }
  const fileBase = `${sanitizeFileSegment(summary.taskId ?? summary.runId ?? 'worktree')}.md`;
  return path.join(queueSubdirFor(root, queue, 'finishes'), fileBase);
}

function renderCodeReviewBundleMarkdown(bundle) {
  const lines = [];
  lines.push(`# Loop Code Review: ${bundle.title ?? bundle.taskId ?? bundle.runId}`);
  lines.push('');
  lines.push(`- Queue: \`${bundle.queue}\``);
  lines.push(`- Task: \`${bundle.taskId ?? 'unknown'}\``);
  lines.push(`- Run: \`${bundle.runId ?? 'unknown'}\``);
  lines.push(`- Status: \`${bundle.status ?? 'unknown'}\``);
  lines.push(`- Generated: \`${bundle.generatedAt}\``);
  lines.push(`- Source run: \`${bundle.sourceRunFile ?? 'unknown'}\``);
  if (bundle.taskPath) lines.push(`- Task artifact: \`${bundle.taskPath}\``);
  lines.push('');

  lines.push('## Worktree');
  if (bundle.worktree) {
    lines.push(`- Branch: \`${bundle.worktree.branch ?? 'unknown'}\``);
    lines.push(`- Path: \`${bundle.worktree.path ?? 'unknown'}\``);
    lines.push(`- Dirty: \`${bundle.worktree.dirty ? 'yes' : 'no'}\``);
    if (bundle.worktree.head) lines.push(`- Head: \`${bundle.worktree.head}\``);
  } else {
    lines.push('- None recorded.');
  }
  lines.push('');

  lines.push('## Verification');
  lines.push(`- Overall: \`${bundle.verifyOk ? 'ok' : 'failed'}\``);
  if (bundle.verification?.length) {
    for (const item of bundle.verification) {
      lines.push(`- \`${item.cmd}\`: exit \`${item.exitCode}\`${item.timedOut ? ' (timed out)' : ''}`);
    }
  } else {
    lines.push('- No verification commands recorded.');
  }
  lines.push('');

  lines.push('## Patch Export');
  lines.push(`- Patch file: \`${bundle.patchExport.patchFile}\``);
  lines.push(`- Exists: \`${bundle.patchExport.exists ? 'yes' : 'no'}\``);
  if (bundle.patchVerify) {
    lines.push(`- Verify: \`${bundle.patchVerify.status}\` ok=\`${bundle.patchVerify.ok ? 'yes' : 'no'}\``);
  }
  if (bundle.applyPlan) {
    lines.push(`- Apply plan: \`${bundle.applyPlan.status}\` canApply=\`${bundle.applyPlan.canApply ? 'yes' : 'no'}\``);
    if (bundle.applyPlan.dirtyAffected) {
      lines.push('');
      lines.push('Dirty affected files:');
      lines.push('');
      lines.push('```text');
      lines.push(trimTail(bundle.applyPlan.affectedStatus?.stdout ?? '', 4000).trimEnd());
      lines.push('```');
    }
  }
  lines.push('');

  lines.push('## Diff Summary');
  if (bundle.diff?.diffStat) {
    lines.push('');
    lines.push('```text');
    lines.push(bundle.diff.diffStat.trimEnd());
    lines.push('```');
  } else {
    lines.push('- No diff stat recorded.');
  }
  if (bundle.diff?.diffNameStatus) {
    lines.push('');
    lines.push('Changed files:');
    lines.push('');
    lines.push('```text');
    lines.push(bundle.diff.diffNameStatus.trimEnd());
    lines.push('```');
  }
  if (bundle.diff?.untracked) {
    lines.push('');
    lines.push('Untracked files:');
    lines.push('');
    lines.push('```text');
    lines.push(bundle.diff.untracked.trimEnd());
    lines.push('```');
  }
  lines.push('');

  if (bundle.errors.length > 0) {
    lines.push('## Collection Errors');
    for (const error of bundle.errors) {
      lines.push(`- \`${error.step}\`: ${error.message}`);
    }
    lines.push('');
  }

  if (bundle.diff?.patch) {
    lines.push('## Patch');
    lines.push('');
    lines.push('```diff');
    lines.push(bundle.diff.patch.trimEnd());
    lines.push('```');
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function closeoutActions({ inspected, worktreeExists, patchExists, patchVerify, reviewExists, reviewJsonExists, cleanupItem }) {
  const actions = [];
  const dirty = Boolean(inspected.worktree?.dirty);
  if (dirty && !patchExists) {
    actions.push(`Export patch: loop-engineering code-worktree-export --queue ${inspected.queue} --task-id ${inspected.taskId}`);
  }
  if (patchExists && patchVerify && !patchVerify.ok) {
    actions.push('Review rejected patch before applying or cleaning up.');
  }
  if (patchExists && (!reviewExists || !reviewJsonExists)) {
    actions.push(`Generate review bundle: loop-engineering code-review-bundle --queue ${inspected.queue} --task-id ${inspected.taskId}`);
  }
  if (worktreeExists && ['cleanup_candidate', 'review_then_cleanup'].includes(cleanupItem?.recommendation)) {
    actions.push(`Clean worktree: loop-engineering code-worktree-cleanup --queue ${inspected.queue} --task-id ${inspected.taskId} --confirm-cleanup`);
  }
  if (worktreeExists && cleanupItem?.recommendation === 'export_before_cleanup') {
    actions.push('Export and review the worktree before cleanup.');
  }
  if (worktreeExists && cleanupItem?.recommendation === 'patch_rejected_review_worktree') {
    actions.push('Resolve rejected patch or inspect the worktree manually before cleanup.');
  }
  return actions;
}

function closeoutStatusFor({ errors, actions, worktreeExists, patchExists, patchVerify, reviewExists, reviewJsonExists, cleanupItem }) {
  if (errors.length > 0) return 'needs_attention';
  if (patchExists && patchVerify && !patchVerify.ok) return 'blocked_patch_rejected';
  if (patchExists && (!reviewExists || !reviewJsonExists)) return 'needs_review';
  if (cleanupItem?.recommendation === 'export_before_cleanup') return 'needs_patch_export';
  if (cleanupItem?.recommendation === 'patch_rejected_review_worktree') return 'blocked_patch_rejected';
  if (worktreeExists && ['cleanup_candidate', 'review_then_cleanup'].includes(cleanupItem?.recommendation)) return 'needs_cleanup';
  if (!worktreeExists || cleanupItem?.recommendation === 'missing_worktree') return actions.length === 0 ? 'closed' : 'closed_with_notes';
  return actions.length === 0 ? 'ready' : 'needs_attention';
}

const AUTOFLOW_STAGES = ['export', 'verify', 'plan', 'review', 'closeout'];

function normalizeAutoflowUntil(value) {
  const normalized = String(value ?? 'review').trim().toLowerCase();
  if (!AUTOFLOW_STAGES.includes(normalized)) {
    throw new Error(`Unsupported autoflow stage: ${value}. Expected one of: ${AUTOFLOW_STAGES.join(', ')}.`);
  }
  return normalized;
}

function stageAtLeast(until, stage) {
  return AUTOFLOW_STAGES.indexOf(until) >= AUTOFLOW_STAGES.indexOf(stage);
}

function stepError(step, err) {
  return {
    step,
    message: err instanceof Error ? err.message : String(err)
  };
}

function stripLargeMarkdown(value) {
  if (!value || typeof value !== 'object') return value;
  const { markdown: _markdown, ...rest } = value;
  return rest;
}

function taskAutoflowActionable(task, until) {
  if (['blocked_patch_rejected', 'closed'].includes(task.overallStatus)) return false;
  const actions = Array.isArray(task.nextActions) ? task.nextActions : [];
  if (actions.some((action) => action.includes('code-worktree-export'))) return true;
  if (actions.some((action) => action.includes('code-review-bundle'))) return true;
  if (stageAtLeast(until, 'closeout') && actions.some((action) => action.includes('code-task-closeout'))) return true;
  return false;
}

async function codeTaskLedgerItem(root, queue, summary, cleanupItem) {
  const taskInfo = summary.taskId
    ? await taskStateFor(root, queue, summary.taskId)
    : { state: null, file: null };
  const patchFile = resolvePatchOutputPath(root, queue, summary, null);
  const patchRel = path.relative(root, patchFile);
  const patchManifestFile = `${patchFile}.json`;
  const patchExists = await exists(patchFile);
  const patchManifestExists = await exists(patchManifestFile);
  const reviewFile = resolveReviewBundleOutputPath(root, queue, summary, null);
  const reviewJsonFile = `${reviewFile}.json`;
  const reviewExists = await exists(reviewFile);
  const reviewJsonExists = await exists(reviewJsonFile);
  const closeoutFile = resolveCloseoutOutputPath(root, queue, summary, null);
  const closeoutJsonFile = `${closeoutFile}.json`;
  const closeoutExists = await exists(closeoutFile);
  const closeoutJsonExists = await exists(closeoutJsonFile);
  let closeoutJson = null;
  if (closeoutJsonExists) {
    try {
      closeoutJson = await readJson(closeoutJsonFile);
    } catch {
      closeoutJson = { closeoutStatus: 'unreadable' };
    }
  }
  const finishFile = resolveFinishOutputPath(root, queue, summary, null);
  const finishJsonFile = `${finishFile}.json`;
  const finishExists = await exists(finishFile);
  const finishJsonExists = await exists(finishJsonFile);
  let finishJson = null;
  if (finishJsonExists) {
    try {
      finishJson = await readJson(finishJsonFile);
    } catch {
      finishJson = { status: 'unreadable', ok: false };
    }
  }

  const worktreeExists = cleanupItem?.exists ?? await recordedWorktreeExists(root, summary.worktree?.path);
  const patchVerifyStatus = cleanupItem?.patchVerify?.status ?? closeoutJson?.patchVerify?.status ?? null;
  const patchVerifyOk = cleanupItem?.patchVerify?.ok ?? closeoutJson?.patchVerify?.ok ?? null;
  const cleanupRecommendation = cleanupItem?.recommendation ?? (worktreeExists ? 'inspect' : 'missing_worktree');
  const closeoutStatus = closeoutJson?.closeoutStatus ?? null;
  const finishStatus = finishJson?.status ?? null;
  const finishOk = finishJson?.ok ?? null;
  const nextActions = statusNextActions({
    queue,
    summary,
    finishExists,
    finishStatus,
    finishOk,
    worktreeExists,
    patchExists,
    patchVerifyOk,
    reviewExists,
    reviewJsonExists,
    closeoutExists,
    closeoutStatus,
    cleanupRecommendation
  });
  const overallStatus = codeTaskOverallStatus({
    finishExists,
    finishStatus,
    finishOk,
    worktreeExists,
    patchExists,
    patchVerifyOk,
    reviewExists,
    reviewJsonExists,
    closeoutExists,
    closeoutStatus,
    cleanupRecommendation
  });

  return {
    taskId: summary.taskId,
    runId: summary.runId,
    title: summary.title,
    runStatus: summary.status,
    taskState: taskInfo.state,
    taskFile: taskInfo.file,
    sourceRunFile: summary.file,
    finishedAt: summary.finishedAt,
    verifyOk: summary.verifyOk,
    worktree: {
      path: summary.worktree?.path ?? null,
      branch: summary.worktree?.branch ?? null,
      dirty: Boolean(summary.worktree?.dirty),
      exists: Boolean(worktreeExists)
    },
    patch: {
      patchFile: patchRel,
      exists: patchExists,
      manifestFile: path.relative(root, patchManifestFile),
      manifestExists: patchManifestExists,
      verifyStatus: patchVerifyStatus,
      verifyOk: patchVerifyOk
    },
    review: {
      reviewFile: path.relative(root, reviewFile),
      exists: reviewExists,
      jsonFile: path.relative(root, reviewJsonFile),
      jsonExists: reviewJsonExists
    },
    closeout: {
      closeoutFile: path.relative(root, closeoutFile),
      exists: closeoutExists,
      jsonFile: path.relative(root, closeoutJsonFile),
      jsonExists: closeoutJsonExists,
      status: closeoutStatus
    },
    finish: {
      finishFile: path.relative(root, finishFile),
      exists: finishExists,
      jsonFile: path.relative(root, finishJsonFile),
      jsonExists: finishJsonExists,
      status: finishStatus,
      ok: finishOk,
      finishedAt: finishJson?.finishedAt ?? null,
      patchApplied: finishJson?.patchApply?.applied ?? null,
      worktreeCleaned: finishJson?.cleanup?.removed ?? null
    },
    cleanup: {
      recommendation: cleanupRecommendation,
      patchStatus: cleanupItem?.patchVerify?.status ?? null
    },
    overallStatus,
    nextActions
  };
}

async function taskStateFor(root, queue, taskId) {
  const found = await findTaskFile(root, queue, taskId);
  if (!found) return { state: null, file: null };
  return {
    state: found.subdir,
    file: path.relative(root, found.file)
  };
}

async function recordedWorktreeExists(root, recordedPath) {
  try {
    return await exists(resolveWorktreePath(root, recordedPath));
  } catch {
    return false;
  }
}

function codeTaskOverallStatus({ finishExists, finishStatus, finishOk, worktreeExists, patchExists, patchVerifyOk, reviewExists, reviewJsonExists, closeoutExists, closeoutStatus, cleanupRecommendation }) {
  if (finishExists && finishOk === true && finishStatus === 'finished') return 'landed';
  if (finishExists && finishOk === false) return 'blocked_finish_attention';
  if (closeoutStatus === 'closed') return 'closed';
  if (closeoutStatus === 'blocked_patch_rejected') return 'blocked_patch_rejected';
  if (patchExists && patchVerifyOk === false) return 'blocked_patch_rejected';
  if (cleanupRecommendation === 'patch_rejected_review_worktree') return 'blocked_patch_rejected';
  if (cleanupRecommendation === 'export_before_cleanup') return 'needs_patch_export';
  if (patchExists && (!reviewExists || !reviewJsonExists)) return 'needs_review';
  if (patchExists && reviewExists && reviewJsonExists && closeoutExists && worktreeExists && ['cleanup_candidate', 'review_then_cleanup'].includes(cleanupRecommendation)) return 'ready_to_finish';
  if (worktreeExists && ['cleanup_candidate', 'review_then_cleanup'].includes(cleanupRecommendation)) return 'needs_cleanup';
  if (!closeoutExists) return 'needs_closeout';
  if (!worktreeExists) return closeoutStatus ?? 'closed_with_notes';
  return closeoutStatus ?? 'ready';
}

function statusNextActions({ queue, summary, finishExists, finishStatus, finishOk, worktreeExists, patchExists, patchVerifyOk, reviewExists, reviewJsonExists, closeoutExists, closeoutStatus, cleanupRecommendation }) {
  const id = summary.taskId ? `--task-id ${summary.taskId}` : `--run-id ${summary.runId}`;
  const actions = [];
  if (finishExists && finishOk === true && finishStatus === 'finished') return actions;
  if (finishExists && finishOk === false) {
    actions.push('Inspect the finish artifact; previous finish attempt needs attention.');
    return actions;
  }
  if (cleanupRecommendation === 'export_before_cleanup') {
    actions.push(`loop-engineering code-worktree-export --queue ${queue} ${id}`);
  }
  if (patchExists && patchVerifyOk === false) {
    actions.push('Inspect the worktree or exported patch; current patch verification is rejected.');
  }
  if (patchExists && (!reviewExists || !reviewJsonExists)) {
    actions.push(`loop-engineering code-review-bundle --queue ${queue} ${id}`);
  }
  const canFinish = patchExists && reviewExists && reviewJsonExists && closeoutExists && worktreeExists && ['cleanup_candidate', 'review_then_cleanup'].includes(cleanupRecommendation);
  if (!closeoutExists) {
    actions.push(`loop-engineering code-task-closeout --queue ${queue} ${id}`);
  } else if (!canFinish && closeoutStatus !== 'closed') {
    const force = closeoutExists ? ' --force' : '';
    actions.push(`loop-engineering code-task-closeout --queue ${queue} ${id}${force}`);
  }
  if (canFinish) {
    actions.push(`loop-engineering code-task-finish --queue ${queue} ${id} --confirm-apply --confirm-cleanup`);
    return actions;
  }
  if (worktreeExists && ['cleanup_candidate', 'review_then_cleanup'].includes(cleanupRecommendation)) {
    actions.push(`loop-engineering code-worktree-cleanup --queue ${queue} --confirm-cleanup`);
  }
  return actions;
}

function renderCodeTaskCloseoutMarkdown(closeout) {
  const lines = [];
  lines.push(`# Loop Code Task Closeout: ${closeout.title ?? closeout.taskId ?? closeout.runId}`);
  lines.push('');
  lines.push(`- Queue: \`${closeout.queue}\``);
  lines.push(`- Task: \`${closeout.taskId ?? 'unknown'}\``);
  lines.push(`- Run: \`${closeout.runId ?? 'unknown'}\``);
  lines.push(`- Task status: \`${closeout.status ?? 'unknown'}\``);
  lines.push(`- Closeout status: \`${closeout.closeoutStatus}\``);
  lines.push(`- Closed at: \`${closeout.closedAt}\``);
  lines.push(`- Source run: \`${closeout.sourceRunFile ?? 'unknown'}\``);
  lines.push('');

  lines.push('## State');
  lines.push(`- Worktree: \`${closeout.worktreeState.exists ? 'exists' : 'missing'}\` ${closeout.worktreeState.path ? `\`${closeout.worktreeState.path}\`` : ''}`.trimEnd());
  lines.push(`- Recorded dirty: \`${closeout.worktreeState.dirty ? 'yes' : 'no'}\``);
  lines.push(`- Verification: \`${closeout.verifyOk ? 'ok' : 'failed'}\``);
  lines.push(`- Patch export: \`${closeout.patchExport.exists ? 'exists' : 'missing'}\` \`${closeout.patchExport.patchFile}\``);
  lines.push(`- Patch verify: \`${closeout.patchVerify?.status ?? 'not_run'}\``);
  lines.push(`- Apply plan: \`${closeout.applyPlan?.status ?? 'not_run'}\``);
  lines.push(`- Review bundle: \`${closeout.review.exists ? 'exists' : 'missing'}\` \`${closeout.review.reviewFile}\``);
  lines.push(`- Cleanup recommendation: \`${closeout.cleanup.recommendation ?? 'unknown'}\``);
  lines.push('');

  if (closeout.actions.length > 0) {
    lines.push('## Next Actions');
    for (const action of closeout.actions) lines.push(`- ${action}`);
    lines.push('');
  }

  if (closeout.worktreeState.currentDiffStat) {
    lines.push('## Current Diff Stat');
    lines.push('');
    lines.push('```text');
    lines.push(closeout.worktreeState.currentDiffStat.trimEnd());
    lines.push('```');
    lines.push('');
  }

  if (closeout.errors.length > 0) {
    lines.push('## Errors');
    for (const error of closeout.errors) lines.push(`- \`${error.step}\`: ${error.message}`);
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderCodeTaskFinishMarkdown(finish) {
  const lines = [];
  lines.push(`# Loop Code Task Finish: ${finish.title ?? finish.taskId ?? finish.runId}`);
  lines.push('');
  lines.push(`- Queue: \`${finish.queue}\``);
  lines.push(`- Task: \`${finish.taskId ?? 'unknown'}\``);
  lines.push(`- Run: \`${finish.runId ?? 'unknown'}\``);
  lines.push(`- Status: \`${finish.status}\``);
  lines.push(`- Started: \`${finish.startedAt}\``);
  lines.push(`- Finished: \`${finish.finishedAt}\``);
  lines.push(`- Source run: \`${finish.sourceRunFile ?? 'unknown'}\``);
  lines.push('');

  lines.push('## Gates');
  lines.push(`- Patch export: \`${finish.gates.patchExists && finish.gates.patchManifestExists ? 'ready' : 'incomplete'}\` \`${finish.artifacts.patchFile}\``);
  lines.push(`- Review bundle: \`${finish.gates.reviewExists && finish.gates.reviewJsonExists ? 'ready' : 'incomplete'}\` \`${finish.artifacts.reviewFile}\``);
  lines.push(`- Closeout: \`${finish.gates.closeoutExists && finish.gates.closeoutJsonExists ? 'ready' : 'incomplete'}\` \`${finish.artifacts.closeoutFile}\``);
  lines.push(`- Apply plan: \`${finish.gates.applyPlan?.status ?? 'not_run'}\``);
  lines.push(`- Cleanup gate: \`${finish.gates.cleanupGate?.ok ? 'ready' : finish.gates.cleanupGate?.reason ?? 'not_run'}\``);
  lines.push('');

  lines.push('## Actions');
  lines.push(`- Patch applied: \`${finish.patchApply?.applied ? 'yes' : 'no'}\``);
  lines.push(`- Worktree cleaned: \`${finish.cleanup?.removed ? 'yes' : 'no'}\``);
  if (finish.cleanup?.worktree) lines.push(`- Worktree: \`${finish.cleanup.worktree}\``);
  if (finish.cleanup?.branch) lines.push(`- Branch retained: \`${finish.cleanup.branch}\``);
  lines.push('');

  if (finish.steps.length > 0) {
    lines.push('## Steps');
    for (const step of finish.steps) {
      const detail = step.reason ? ` (${step.reason})` : '';
      lines.push(`- \`${step.name}\`: \`${step.status}\`${detail}`);
    }
    lines.push('');
  }

  if (finish.errors.length > 0) {
    lines.push('## Errors');
    for (const error of finish.errors) lines.push(`- \`${error.step}\`: ${error.message}`);
    lines.push('');
  }

  lines.push('## Safety');
  lines.push('- Required `--confirm-apply` and `--confirm-cleanup`.');
  lines.push('- Did not stage, commit, push, merge, delete branches, or change queue state.');
  lines.push('');
  return `${lines.join('\n').trimEnd()}\n`;
}

function sanitizeFileSegment(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'worktree';
}

async function findCodeWorktreeRun(root, queue, options = {}) {
  const entries = (await recentRuns(root, queue, { limit: options.limit ?? 100 }))
    .filter((entry) => entry.run?.queue === queue && entry.run?.worktree)
    .reverse();
  const found = entries.find((entry) => {
    if (options.runId && entry.run.runId === options.runId) return true;
    if (options.taskId && entry.run.taskId === options.taskId) return true;
    return !options.runId && !options.taskId;
  });
  if (!found) {
    const target = options.runId ? `run ${options.runId}` : options.taskId ? `task ${options.taskId}` : 'latest worktree run';
    throw new Error(`No code worktree artifact found for ${target}.`);
  }
  return found;
}

function resolveWorktreePath(root, recordedPath) {
  if (typeof recordedPath !== 'string' || !recordedPath.trim()) {
    throw new Error('Code worktree artifact is missing worktree.path.');
  }
  const full = path.isAbsolute(recordedPath)
    ? path.resolve(recordedPath)
    : path.resolve(root, safeRelativePath(recordedPath, 'worktree path'));
  const rel = path.relative(root, full);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Unsafe worktree path outside root: ${recordedPath}`);
  }
  return full;
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

function buildQueueEnv(root, queue, task, taskFile, runId, extra = {}) {
  return {
    ...process.env,
    LOOP_QUEUE_ID: queue,
    LOOP_TASK_ID: task.id,
    LOOP_TASK_TITLE: task.title,
    LOOP_TASK_BODY: task.body,
    LOOP_TASK_FILE: taskFile,
    LOOP_TASK_FILE_REL: path.relative(root, taskFile),
    LOOP_RUN_ID: runId,
    ...extra
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

async function runDispatchWithRetry(root, options, queue, task, activeFile, runId, timeoutMs, runContext = {}) {
  const attempts = [];
  const retry = options.retry ?? {};
  const maxAttempts = retry.maxAttempts ?? 1;
  const retryDelayMs = retry.retryDelayMs ?? 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = new Date().toISOString();
    const result = await runCommand(options.dispatcher, {
      cwd: runContext.cwd ?? root,
      env: {
        ...buildQueueEnv(root, queue, task, activeFile, runId, runContext.env ?? {}),
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

function worktreeEnabled(options) {
  return Boolean(options.worktree?.enabled);
}

function sanitizeBranchSegment(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'task';
}

async function prepareWorktree(root, queue, task, runId, config = {}) {
  const baseRel = safeRelativePath(config.baseDir ?? path.join('runtime', 'loops', queue, 'worktrees'), 'worktree baseDir');
  const baseDir = path.join(root, baseRel);
  await mkdir(baseDir, { recursive: true });
  const shortTask = sanitizeBranchSegment(task.id).replace(/\//g, '-');
  const worktreeDir = path.join(baseDir, shortTask);
  const prefix = sanitizeBranchSegment(config.branchPrefix ?? `loop/${queue}`);
  const branch = `${prefix}/${shortTask}`;
  const add = await runCommand(`git worktree add -b ${shellQuote(branch)} ${shellQuote(worktreeDir)} HEAD`, {
    cwd: root,
    timeoutMs: config.setupTimeoutMs ?? 120000
  });
  const head = add.exitCode === 0
    ? await runCommand('git rev-parse HEAD', { cwd: worktreeDir, timeoutMs: 30000 })
    : null;
  return {
    enabled: true,
    path: worktreeDir,
    pathRel: path.relative(root, worktreeDir),
    branch,
    setup: compactCommandResult(add),
    head: head?.exitCode === 0 ? head.stdout.trim() : null,
    runId
  };
}

async function inspectWorktree(worktree) {
  if (!worktree?.path || worktree.setup?.exitCode !== 0) return null;
  const status = await runCommand('git status --short', { cwd: worktree.path, timeoutMs: 30000 });
  const diffStat = await runCommand('git diff --stat', { cwd: worktree.path, timeoutMs: 30000 });
  const diffNameStatus = await runCommand('git diff --name-status', { cwd: worktree.path, timeoutMs: 30000 });
  const untracked = await runCommand('git ls-files --others --exclude-standard', { cwd: worktree.path, timeoutMs: 30000 });
  return {
    status: compactCommandResult(status),
    diffStat: trimTail(diffStat.stdout, 4000),
    diffNameStatus: trimTail(diffNameStatus.stdout, 4000),
    untracked: trimTail(untracked.stdout, 4000),
    dirty: Boolean(status.stdout.trim())
  };
}

async function runVerifyCommands(commands, cwd, timeoutMs) {
  const results = [];
  for (const cmd of commands ?? []) {
    const startedAt = new Date().toISOString();
    const result = await runCommand(cmd, { cwd, timeoutMs });
    results.push({
      cmd,
      startedAt,
      finishedAt: new Date().toISOString(),
      result: compactCommandResult(result)
    });
    if (result.exitCode !== 0) break;
  }
  return results;
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
    let worktree = null;
    let worktreeInspection = null;
    let verification = [];

    try {
      preflight = await runPreflight(root, options.preflightConfig, Math.min(timeoutMs, 3 * 60 * 1000));
      if (preflight && preflight.exitCode !== 0) {
        finalStatus = 'blocked_preflight';
        exitCode = 2;
      } else {
        const runContext = {};
        if (worktreeEnabled(options)) {
          worktree = await prepareWorktree(root, queue, task, runId, options.worktree);
          if (worktree.setup.exitCode !== 0) {
            finalStatus = 'worktree_failed';
            exitCode = 1;
          } else {
            runContext.cwd = worktree.path;
            runContext.env = {
              LOOP_ROOT: root,
              LOOP_WORKTREE_PATH: worktree.path,
              LOOP_WORKTREE_PATH_REL: worktree.pathRel,
              LOOP_WORKTREE_BRANCH: worktree.branch
            };
          }
        }
        if (finalStatus === 'unknown') {
          dispatchAttempts = await runDispatchWithRetry(root, options, queue, task, activeFile, runId, timeoutMs, runContext);
          dispatch = dispatchAttempts[dispatchAttempts.length - 1]?.result ?? null;
          if (dispatch?.exitCode === 0 && worktreeEnabled(options)) {
            verification = await runVerifyCommands(options.worktree?.verifyCommands ?? [], worktree.path, timeoutMs);
            const verifyOk = verification.every((entry) => entry.result.exitCode === 0);
            finalStatus = verifyOk ? 'completed' : 'verify_failed';
          } else {
            finalStatus = dispatch?.exitCode === 0 ? 'completed' : 'failed';
          }
        }
        worktreeInspection = await inspectWorktree(worktree);
        destination = finalStatus === 'completed'
        ? queueSubdirFor(root, queue, 'done')
        : queueSubdirFor(root, queue, 'failed');
        exitCode = finalStatus === 'completed' ? 0 : 1;
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
      worktree: worktree ? {
        enabled: true,
        path: worktree.pathRel,
        branch: worktree.branch,
        head: worktree.head,
        setup: worktree.setup,
        inspection: worktreeInspection
      } : null,
      verification,
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
