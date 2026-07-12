#!/usr/bin/env node
import path from 'node:path';
import {
  applyBreaker,
  codeWorktreeDiff,
  codeWorktreeCleanup,
  codeWorktreeCleanupPlan,
  codeWorktreeExport,
  codeWorktreeInspect,
  codeWorktreeList,
  codePatchApply,
  codePatchApplyPlan,
  codePatchVerify,
  codeReviewBundle,
  codeTaskAutoflow,
  codeTaskCloseout,
  codeTaskStatus,
  configFilesFromArgs,
  doctorReport,
  initCodeQueueConfig,
  failureSignature,
  initWorkspace,
  initQueueConfig,
  isoStamp,
  latestRun,
  loadQueueConfig,
  loadSpec,
  loadState,
  mergeQueueOptions,
  nextState,
  enqueueTask,
  queueCancel,
  queuePeek,
  queueRequeue,
  queueStatus,
  summarizeLoopRuns,
  runCheck,
  runQueueOnce,
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
    else if (a === '--queue') args.queue = argv[++i];
    else if (a === '--id') args.id = argv[++i];
    else if (a === '--title') args.title = argv[++i];
    else if (a === '--task') args.task = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--dispatcher') args.dispatcher = argv[++i];
    else if (a === '--preflight-config') args.preflightConfig = argv[++i];
    else if (a === '--timeout-ms') args.timeoutMs = Number.parseInt(argv[++i], 10);
    else if (a === '--lease-ms') args.leaseMs = Number.parseInt(argv[++i], 10);
    else if (a === '--stale-active-ms') args.staleActiveMs = Number.parseInt(argv[++i], 10);
    else if (a === '--max-attempts') args.maxAttempts = Number.parseInt(argv[++i], 10);
    else if (a === '--retry-delay-ms') args.retryDelayMs = Number.parseInt(argv[++i], 10);
    else if (a === '--retry-exit-codes') args.retryExitCodes = argv[++i].split(',').filter(Boolean).map((v) => Number.parseInt(v, 10));
    else if (a === '--task-id') args.taskId = argv[++i];
    else if (a === '--run-id') args.runId = argv[++i];
    else if (a === '--output') args.output = argv[++i];
    else if (a === '--patch-output') args.patchOutput = argv[++i];
    else if (a === '--review-output') args.reviewOutput = argv[++i];
    else if (a === '--closeout-output') args.closeoutOutput = argv[++i];
    else if (a === '--patch') args.patch = argv[++i];
    else if (a === '--until') args.until = argv[++i];
    else if (a === '--reason') args.reason = argv[++i];
    else if (a === '--limit') args.limit = Number.parseInt(argv[++i], 10);
    else if (a === '--notify-command') args.notifyCommand = argv[++i];
    else if (a === '--include-active') args.includeActive = true;
    else if (a === '--confirm-apply') args.confirmApply = true;
    else if (a === '--confirm-cleanup') args.confirmCleanup = true;
    else if (a === '--allow-dirty') args.allowDirty = true;
    else if (a === '--include-orphans') args.includeOrphans = true;
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
  loop-engineering summarize [--id name | --queue name] [--limit 20] [--root <workspace>] [--json]
  loop-engineering doctor [--root <workspace>] [--json]
  loop-engineering enqueue --queue name --title "Title" (--task "Body" | --file task.md) [--root <workspace>]
  loop-engineering run-queue --config configs/loops/queues/name.json [--root <workspace>]
  loop-engineering run-queue --queue name --dispatcher "command" [--preflight-config configs/loops/name.json] [--root <workspace>]
  loop-engineering queue-status --queue name [--root <workspace>] [--json]
  loop-engineering queue-init --queue name [--root <workspace>] [--force]
  loop-engineering code-queue-init --queue name [--root <workspace>] [--force]
  loop-engineering queue-peek --queue name [--root <workspace>] [--json]
  loop-engineering queue-cancel --queue name --task-id id [--reason "..."] [--root <workspace>]
  loop-engineering queue-requeue --queue name --task-id id [--root <workspace>]
  loop-engineering code-worktree-list --queue name [--limit 20] [--root <workspace>] [--json]
  loop-engineering code-worktree-inspect --queue name [--task-id id | --run-id id] [--root <workspace>] [--json]
  loop-engineering code-worktree-diff --queue name [--task-id id | --run-id id] [--root <workspace>] [--json]
  loop-engineering code-worktree-export --queue name [--task-id id | --run-id id] [--output file.patch] [--force] [--root <workspace>] [--json]
  loop-engineering code-patch-verify --patch runtime/loops/code-tasks/patches/task.patch [--root <workspace>] [--json]
  loop-engineering code-patch-apply-plan --patch runtime/loops/code-tasks/patches/task.patch [--root <workspace>] [--allow-dirty] [--json]
  loop-engineering code-patch-apply --patch runtime/loops/code-tasks/patches/task.patch --confirm-apply [--root <workspace>] [--allow-dirty] [--json]
  loop-engineering code-review-bundle --queue name [--task-id id | --run-id id] [--output review.md] [--force] [--root <workspace>] [--json]
  loop-engineering code-task-closeout --queue name [--task-id id | --run-id id] [--output closeout.md] [--force] [--root <workspace>] [--json]
  loop-engineering code-task-autoflow --queue name [--task-id id | --run-id id] [--until review|closeout] [--force] [--root <workspace>] [--json]
  loop-engineering code-task-status --queue name [--task-id id | --run-id id] [--limit 20] [--root <workspace>] [--json]
  loop-engineering code-worktree-cleanup-plan --queue name [--limit 50] [--root <workspace>] [--json]
  loop-engineering code-worktree-cleanup --queue name --confirm-cleanup [--limit 50] [--include-orphans] [--root <workspace>] [--json]

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

async function summarizeCommand(args) {
  const summaries = await summarizeLoopRuns(args.root, {
    id: args.id,
    queue: args.queue,
    limit: args.limit ?? 20
  });
  if (args.json) {
    console.log(JSON.stringify(summaries, null, 2));
  } else if (summaries.length === 0) {
    console.log('no run artifacts found');
  } else {
    for (const summary of summaries) {
      console.log(summary.id);
      console.log(`  inspected/readable: ${summary.inspectedRuns}/${summary.readableRuns}`);
      console.log(`  latest: ${summary.latestStatus ?? 'none'} ${summary.latestRun ?? ''}`.trimEnd());
      console.log(`  success rate: ${summary.successRate === null ? 'n/a' : `${summary.successRate}%`}`);
      console.log(`  avg duration: ${summary.averageDurationMs === null ? 'n/a' : `${summary.averageDurationMs}ms`}`);
      console.log(`  counts: ${Object.entries(summary.counts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
      if (summary.recentFailures.length > 0) {
        console.log('  recent failures:');
        for (const failure of summary.recentFailures) {
          console.log(`    - ${failure.status} ${failure.file}`);
          if (failure.reason) console.log(`      reason: ${failure.reason}`);
        }
      }
    }
  }
  return 0;
}

async function doctorCommand(args) {
  const report = await doctorReport(args.root, { limit: args.limit ?? 10 });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`loop-engineering doctor: ${report.ok ? 'ok' : 'fail'} (${report.failCount} fail, ${report.warnCount} warn)`);
    for (const check of report.checks) {
      const status = check.ok ? 'ok' : check.level;
      console.log(`${status} ${check.id}`);
      if (!check.ok && check.detail) {
        const detail = typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail);
        console.log(`  ${detail}`);
      }
    }
  }
  return report.failCount > 0 ? 1 : 0;
}

async function initCommand(args) {
  const config = await initWorkspace(args.root, { force: args.force });
  console.log(`initialized loop engineering at ${args.root}`);
  console.log(`config: ${config}`);
  return 0;
}

async function queueInitCommand(args) {
  if (!args.queue) throw new Error('queue-init requires --queue.');
  const config = await initQueueConfig(args.root, args.queue, { force: args.force });
  console.log(`initialized queue ${args.queue} at ${args.root}`);
  console.log(`config: ${config}`);
  return 0;
}

async function codeQueueInitCommand(args) {
  if (!args.queue) throw new Error('code-queue-init requires --queue.');
  const config = await initCodeQueueConfig(args.root, args.queue, { force: args.force });
  console.log(`initialized code worktree queue ${args.queue} at ${args.root}`);
  console.log(`config: ${config}`);
  return 0;
}

async function enqueueCommand(args) {
  if (!args.queue) throw new Error('enqueue requires --queue.');
  const result = await enqueueTask(args.root, args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`queued: ${result.file}`);
  }
  return 0;
}

async function runQueueCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, {
    ...args,
    retry: buildRetryArgs(args, config.retry)
  });
  const result = await runQueueOnce(args.root, options);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.status === 'locked') {
    console.log(`${result.queue}: locked until ${result.lock?.expiresAt ?? 'unknown'}`);
  } else if (!result.processed) {
    console.log(`${result.queue}: no queued tasks`);
  } else {
    console.log(`${result.queue}: ${result.status}`);
    console.log(`task: ${result.taskPath}`);
    console.log(`run: ${result.runPath}`);
  }
  return result.exitCode;
}

async function queueStatusCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await queueStatus(args.root, options.queue);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result.queue);
    for (const [key, value] of Object.entries(result)) {
      if (key !== 'queue') console.log(`  ${key}: ${value}`);
    }
  }
  return 0;
}

async function queuePeekCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await queuePeek(args.root, options.queue, { limit: args.limit });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.tasks.length === 0) {
    console.log(`${result.queue}: no queued tasks`);
  } else {
    for (const task of result.tasks) {
      console.log(`${task.id} ${task.title}`);
      console.log(`  attempts: ${task.attempts}`);
      console.log(`  file: ${task.file}`);
    }
  }
  return 0;
}

async function queueCancelCommand(args) {
  if (!args.taskId) throw new Error('queue-cancel requires --task-id.');
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await queueCancel(args.root, options.queue, args.taskId, {
    reason: args.reason,
    includeActive: args.includeActive
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`canceled ${result.taskId}: ${result.file}`);
  return 0;
}

async function queueRequeueCommand(args) {
  if (!args.taskId) throw new Error('queue-requeue requires --task-id.');
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await queueRequeue(args.root, options.queue, args.taskId);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`requeued ${result.taskId}: ${result.file}`);
  return 0;
}

async function codeWorktreeListCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeWorktreeList(args.root, options.queue, { limit: args.limit });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.worktrees.length === 0) {
    console.log(`${result.queue}: no code worktree artifacts found`);
  } else {
    for (const item of result.worktrees) {
      console.log(`${item.status} ${item.taskId}`);
      console.log(`  branch: ${item.worktree?.branch ?? 'none'}`);
      console.log(`  path: ${item.worktree?.path ?? 'none'}`);
      console.log(`  dirty: ${item.worktree?.dirty ? 'yes' : 'no'}`);
      console.log(`  verify: ${item.verifyOk ? 'ok' : 'fail'}`);
      console.log(`  run: ${item.file}`);
    }
  }
  return 0;
}

async function codeWorktreeInspectCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeWorktreeInspect(args.root, options.queue, {
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status} ${result.taskId}`);
    console.log(`  title: ${result.title ?? ''}`);
    console.log(`  branch: ${result.worktree?.branch ?? 'none'}`);
    console.log(`  path: ${result.worktree?.path ?? 'none'}`);
    console.log(`  head: ${result.worktree?.head ?? 'none'}`);
    console.log(`  dirty: ${result.worktree?.dirty ? 'yes' : 'no'}`);
    console.log(`  verify: ${result.verifyOk ? 'ok' : 'fail'}`);
    if (result.worktree?.statusShort) console.log(`  status:\n${indent(result.worktree.statusShort)}`);
    if (result.worktree?.diffStat) console.log(`  diff stat:\n${indent(result.worktree.diffStat)}`);
    if (result.worktree?.diffNameStatus) console.log(`  diff names:\n${indent(result.worktree.diffNameStatus)}`);
    if (result.worktree?.untracked) console.log(`  untracked:\n${indent(result.worktree.untracked)}`);
    console.log(`  run: ${result.file}`);
  }
  return 0;
}

async function codeWorktreeDiffCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeWorktreeDiff(args.root, options.queue, {
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status} ${result.taskId}`);
    console.log(`  branch: ${result.worktree?.branch ?? 'none'}`);
    console.log(`  path: ${result.worktree?.path ?? 'none'}`);
    console.log(`  run: ${result.file}`);
    if (result.diffStat) console.log(`\nDiff stat:\n${result.diffStat}`);
    if (result.diffNameStatus) console.log(`\nDiff names:\n${result.diffNameStatus}`);
    if (result.untracked) console.log(`\nUntracked files:\n${result.untracked}`);
    if (result.patch) console.log(`\nPatch:\n${result.patch}`);
    else console.log('\nPatch: (empty)');
  }
  return 0;
}

async function codeWorktreeExportCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeWorktreeExport(args.root, options.queue, {
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit,
    output: args.output,
    force: args.force
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status} ${result.taskId}`);
    console.log(`  patch: ${result.patchFile}`);
    console.log(`  manifest: ${result.manifestFile}`);
    console.log(`  bytes: ${result.patchBytes}`);
    if (result.untracked) console.log(`  untracked:\n${indent(result.untracked)}`);
  }
  return 0;
}

async function codePatchVerifyCommand(args) {
  const result = await codePatchVerify(args.root, {
    patch: args.patch,
    timeoutMs: args.timeoutMs
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status}: ${result.patchFile}`);
    console.log(`  ok: ${result.ok ? 'yes' : 'no'}`);
    console.log(`  files: ${result.diffFiles.length}`);
    if (result.applyCheck) {
      console.log(`  git apply --check: exit ${result.applyCheck.exitCode}`);
      if (result.applyCheck.stderr) console.log(`  stderr:\n${indent(result.applyCheck.stderr)}`);
      if (result.applyCheck.stdout) console.log(`  stdout:\n${indent(result.applyCheck.stdout)}`);
    }
  }
  return result.ok ? 0 : 1;
}

async function codePatchApplyPlanCommand(args) {
  const result = await codePatchApplyPlan(args.root, {
    patch: args.patch,
    timeoutMs: args.timeoutMs,
    allowDirty: args.allowDirty
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status}: ${result.patchFile}`);
    console.log(`  can apply: ${result.canApply ? 'yes' : 'no'}`);
    console.log(`  files: ${result.diffFiles.length}`);
    if (result.affectedPaths.length > 0) console.log(`  affected:\n${indent(result.affectedPaths.join('\n'))}`);
    if (result.dirtyAffected) console.log(`  dirty affected files:\n${indent(result.affectedStatus.stdout)}`);
    if (result.applyCheck) {
      console.log(`  git apply --check: exit ${result.applyCheck.exitCode}`);
      if (result.applyCheck.stderr) console.log(`  stderr:\n${indent(result.applyCheck.stderr)}`);
      if (result.applyCheck.stdout) console.log(`  stdout:\n${indent(result.applyCheck.stdout)}`);
    }
  }
  return result.ok ? 0 : 1;
}

async function codePatchApplyCommand(args) {
  const result = await codePatchApply(args.root, {
    patch: args.patch,
    timeoutMs: args.timeoutMs,
    allowDirty: args.allowDirty,
    confirmApply: args.confirmApply
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.status}: ${result.patchFile}`);
    console.log(`  applied: ${result.applied ? 'yes' : 'no'}`);
    console.log(`  files: ${result.diffFiles.length}`);
    if (result.affectedPaths?.length > 0) console.log(`  affected:\n${indent(result.affectedPaths.join('\n'))}`);
    if (result.apply) {
      console.log(`  git apply: exit ${result.apply.exitCode}`);
      if (result.apply.stderr) console.log(`  stderr:\n${indent(result.apply.stderr)}`);
      if (result.apply.stdout) console.log(`  stdout:\n${indent(result.apply.stdout)}`);
    }
    if (result.applyCheck) console.log(`  prior git apply --check: exit ${result.applyCheck.exitCode}`);
  }
  return result.ok ? 0 : 1;
}

async function codeReviewBundleCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeReviewBundle(args.root, options.queue, {
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit,
    output: args.output,
    force: args.force,
    timeoutMs: args.timeoutMs,
    allowDirty: args.allowDirty
  });
  if (args.json) {
    const { markdown: _markdown, ...json } = result;
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log(`${result.status} ${result.taskId}`);
    console.log(`  review: ${result.reviewFile}`);
    console.log(`  json: ${result.jsonFile}`);
    console.log(`  patch: ${result.patchExport.patchFile} (${result.patchExport.exists ? 'exists' : 'missing'})`);
    if (result.patchVerify) console.log(`  patch verify: ${result.patchVerify.status}`);
    if (result.applyPlan) console.log(`  apply plan: ${result.applyPlan.status} canApply=${result.applyPlan.canApply ? 'yes' : 'no'}`);
    if (result.errors.length > 0) {
      console.log(`  errors: ${result.errors.length}`);
      for (const error of result.errors) console.log(`    ${error.step}: ${error.message}`);
    }
  }
  return 0;
}

async function codeTaskCloseoutCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeTaskCloseout(args.root, options.queue, {
    config: options,
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit,
    output: args.output,
    force: args.force,
    timeoutMs: args.timeoutMs,
    allowDirty: args.allowDirty
  });
  if (args.json) {
    const { markdown: _markdown, ...json } = result;
    console.log(JSON.stringify(json, null, 2));
  } else {
    console.log(`${result.closeoutStatus} ${result.taskId ?? result.runId}`);
    console.log(`  closeout: ${result.closeoutFile}`);
    console.log(`  json: ${result.jsonFile}`);
    console.log(`  review: ${result.review.exists ? 'exists' : 'missing'} ${result.review.reviewFile}`);
    console.log(`  patch: ${result.patchExport.exists ? 'exists' : 'missing'} ${result.patchExport.patchFile}`);
    console.log(`  worktree: ${result.worktreeState.exists ? 'exists' : 'missing'} ${result.worktreeState.path ?? 'none'}`);
    console.log(`  cleanup: ${result.cleanup.recommendation ?? 'unknown'}`);
    if (result.actions.length > 0) {
      console.log('  next actions:');
      for (const action of result.actions) console.log(`    - ${action}`);
    }
    if (result.errors.length > 0) {
      console.log(`  errors: ${result.errors.length}`);
      for (const error of result.errors) console.log(`    ${error.step}: ${error.message}`);
    }
  }
  return 0;
}

async function codeTaskAutoflowCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeTaskAutoflow(args.root, options.queue, {
    config: options,
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit,
    until: args.until,
    patch: args.patchOutput,
    review: args.reviewOutput,
    closeout: args.closeoutOutput,
    force: args.force,
    timeoutMs: args.timeoutMs,
    allowDirty: args.allowDirty
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: autoflow ${result.status}`);
    console.log(`  task: ${result.taskId ?? result.runId}`);
    console.log(`  until: ${result.until}`);
    console.log(`  patch: ${result.artifacts.patchFile}`);
    console.log(`  review: ${result.artifacts.reviewFile}`);
    if (result.until === 'closeout') console.log(`  closeout: ${result.artifacts.closeoutFile}`);
    console.log('  safety: no apply, no cleanup, no queue state changes');
    for (const step of result.steps) {
      const detail = step.artifact ? ` ${step.artifact}` : '';
      console.log(`  ${step.name}: ${step.status}${detail}`);
    }
    if (result.errors.length > 0) {
      console.log(`  errors: ${result.errors.length}`);
      for (const error of result.errors) console.log(`    ${error.step}: ${error.message}`);
    }
  }
  return result.ok ? 0 : 1;
}

async function codeTaskStatusCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeTaskStatus(args.root, options.queue, {
    config: options,
    taskId: args.taskId,
    runId: args.runId,
    limit: args.limit
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.tasks.length === 0) {
    console.log(`${result.queue}: no code task artifacts found`);
  } else {
    console.log(`${result.queue}: code task status`);
    console.log(`  tasks: ${result.tasks.length}`);
    console.log(`  counts: ${Object.entries(result.counts).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`);
    for (const task of result.tasks) {
      console.log(`${task.overallStatus} ${task.taskId ?? task.runId}`);
      console.log(`  title: ${task.title ?? ''}`);
      console.log(`  task state: ${task.taskState ?? 'unknown'}`);
      console.log(`  worktree: ${task.worktree.exists ? 'exists' : 'missing'} ${task.worktree.path ?? 'none'}`);
      console.log(`  patch: ${task.patch.exists ? 'exists' : 'missing'} ${task.patch.verifyStatus ?? 'not_run'}`);
      console.log(`  review: ${task.review.exists ? 'exists' : 'missing'}`);
      console.log(`  closeout: ${task.closeout.exists ? task.closeout.status ?? 'exists' : 'missing'}`);
      console.log(`  cleanup: ${task.cleanup.recommendation ?? 'unknown'}`);
      if (task.nextActions.length > 0) {
        console.log('  next actions:');
        for (const action of task.nextActions) console.log(`    - ${action}`);
      }
      console.log(`  run: ${task.sourceRunFile}`);
    }
  }
  return 0;
}

async function codeWorktreeCleanupPlanCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeWorktreeCleanupPlan(args.root, options.queue, {
    config: options,
    limit: args.limit
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: cleanup plan`);
    console.log(`  inspected: ${result.inspectedRuns}`);
    console.log(`  cleanup candidates: ${result.cleanupCandidates.length}`);
    console.log(`  unexported dirty: ${result.unexportedDirty.length}`);
    console.log(`  rejected patches: ${result.rejectedPatches.length}`);
    console.log(`  missing worktrees: ${result.missingWorktrees.length}`);
    console.log(`  orphan worktrees: ${result.orphanWorktrees.length}`);
    for (const item of result.worktrees) {
      console.log(`${item.recommendation} ${item.taskId ?? item.runId}`);
      console.log(`  worktree: ${item.worktree?.path ?? 'none'}`);
      if (item.exportedPatchFile) console.log(`  patch: ${item.exportedPatchFile} (${item.patchVerify?.status ?? 'unknown'})`);
      for (const command of item.recommendedCommands) console.log(`  command: ${command}`);
    }
    for (const item of result.orphanWorktrees) {
      console.log(`orphan_worktree ${item.path}`);
      console.log(`  command: ${item.command}`);
    }
  }
  return 0;
}

async function codeWorktreeCleanupCommand(args) {
  const config = await loadQueueConfig(args.root, args.config);
  const options = mergeQueueOptions(config, args);
  const result = await codeWorktreeCleanup(args.root, options.queue, {
    config: options,
    limit: args.limit,
    confirmCleanup: args.confirmCleanup,
    includeOrphans: args.includeOrphans
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`${result.queue}: cleanup ${result.status}`);
    console.log(`  removed worktrees: ${result.removedWorktrees.length}`);
    console.log(`  removed orphans: ${result.removedOrphans.length}`);
    console.log(`  skipped: ${result.skipped.length}`);
    for (const item of result.removedWorktrees) {
      console.log(`removed ${item.taskId ?? item.runId}`);
      console.log(`  worktree: ${item.worktree}`);
      console.log(`  git worktree remove: exit ${item.remove.exitCode}`);
      if (item.branch) console.log(`  branch retained: ${item.branch}`);
    }
    for (const item of result.removedOrphans) {
      console.log(`removed_orphan ${item.path}`);
      console.log(`  git worktree remove: exit ${item.remove.exitCode}`);
    }
    for (const item of result.skipped) {
      console.log(`skipped ${item.taskId ?? item.runId ?? item.path}`);
      console.log(`  reason: ${item.reason}`);
    }
  }
  return result.ok ? 0 : 1;
}

function indent(value) {
  return String(value).split('\n').filter(Boolean).map((line) => `    ${line}`).join('\n');
}

function buildRetryArgs(args, existing) {
  if (args.maxAttempts === undefined && args.retryDelayMs === undefined && args.retryExitCodes === undefined) {
    return existing;
  }
  return {
    ...(existing ?? {}),
    ...(args.maxAttempts !== undefined ? { maxAttempts: args.maxAttempts } : {}),
    ...(args.retryDelayMs !== undefined ? { retryDelayMs: args.retryDelayMs } : {}),
    ...(args.retryExitCodes !== undefined ? { retryExitCodes: args.retryExitCodes } : {})
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (args.help || !command) {
    console.log(HELP);
    return args.help ? 0 : 1;
  }
  if (command === 'init') return initCommand(args);
  if (command === 'queue-init') return queueInitCommand(args);
  if (command === 'code-queue-init') return codeQueueInitCommand(args);
  if (command === 'run') return runCommand(args);
  if (command === 'verify') return verifyCommand(args);
  if (command === 'status') return statusCommand(args);
  if (command === 'summarize') return summarizeCommand(args);
  if (command === 'doctor') return doctorCommand(args);
  if (command === 'enqueue') return enqueueCommand(args);
  if (command === 'run-queue') return runQueueCommand(args);
  if (command === 'queue-status') return queueStatusCommand(args);
  if (command === 'queue-peek') return queuePeekCommand(args);
  if (command === 'queue-cancel') return queueCancelCommand(args);
  if (command === 'queue-requeue') return queueRequeueCommand(args);
  if (command === 'code-worktree-list') return codeWorktreeListCommand(args);
  if (command === 'code-worktree-inspect') return codeWorktreeInspectCommand(args);
  if (command === 'code-worktree-diff') return codeWorktreeDiffCommand(args);
  if (command === 'code-worktree-export') return codeWorktreeExportCommand(args);
  if (command === 'code-patch-verify') return codePatchVerifyCommand(args);
  if (command === 'code-patch-apply-plan') return codePatchApplyPlanCommand(args);
  if (command === 'code-patch-apply') return codePatchApplyCommand(args);
  if (command === 'code-review-bundle') return codeReviewBundleCommand(args);
  if (command === 'code-task-closeout') return codeTaskCloseoutCommand(args);
  if (command === 'code-task-autoflow') return codeTaskAutoflowCommand(args);
  if (command === 'code-task-status') return codeTaskStatusCommand(args);
  if (command === 'code-worktree-cleanup-plan') return codeWorktreeCleanupPlanCommand(args);
  if (command === 'code-worktree-cleanup') return codeWorktreeCleanupCommand(args);
  throw new Error(`Unknown command: ${command}`);
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
