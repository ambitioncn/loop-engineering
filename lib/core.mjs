import { access, copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
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
