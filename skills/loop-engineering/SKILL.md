---
name: loop-engineering
description: Create, run, inspect, and schedule OpenClaw-native loop engineering workflows for repeated agent tasks, health checks, task queues, cron-triggered verification, circuit-breaker escalation, and explicit "走 loop" / "loop engineering" task routing.
---

# Loop Engineering

Use this skill when a user explicitly asks to use loop engineering, says `走 loop`,
asks to enqueue a task into a loop-managed runner, or wants a repeated agent task
wrapped with preflight, verification, local artifacts, and escalation rules.

## Default Policy

- Do not route ordinary chat or simple tasks into loop engineering.
- Route only when the user explicitly says `走 loop`, `loop engineering`,
  `丢进 Ironman loop`, `loop Ironman`, or `task-runner`.
- If the user says `走 loop 并立刻执行`, enqueue the task and immediately run one tick.
- Keep high-risk actions gated: external sends, publishing, destructive commands,
  production config changes, memory deletion/migration, or credential changes still
  require separate confirmation.

## CLI

Prefer the npm CLI when installed:

```bash
loop-engineering verify --root /path/to/workspace
loop-engineering run --root /path/to/workspace --config configs/loops/<id>.json
loop-engineering status --root /path/to/workspace
loop-engineering doctor --root /path/to/workspace
loop-engineering summarize --root /path/to/workspace --limit 20
loop-engineering enqueue --root /path/to/workspace --queue <queue> --title "Title" --task "Task body"
loop-engineering queue-init --root /path/to/workspace --queue <queue>
loop-engineering run-queue --root /path/to/workspace --config configs/loops/queues/<queue>.json
loop-engineering queue-status --root /path/to/workspace --queue <queue>
loop-engineering queue-peek --root /path/to/workspace --queue <queue>
loop-engineering queue-cancel --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering queue-requeue --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-queue-init --root /path/to/workspace --queue <queue>
loop-engineering code-worktree-list --root /path/to/workspace --queue <queue>
loop-engineering code-worktree-inspect --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-worktree-diff --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-worktree-export --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-patch-verify --root /path/to/workspace --patch runtime/loops/<queue>/patches/<id>.patch
```

If the package is not installed but exists in the workspace, use:

```bash
node packages/loop-engineering/bin/loop-engineering.mjs <command>
```

Initialize a workspace:

```bash
loop-engineering init --root /path/to/workspace
```

## Loop Spec

Create specs under `configs/loops/<id>.json`. Keep first versions `L1` and
`report-only` unless the user has approved a stronger action policy.

Minimal shape:

```json
{
  "id": "workspace-health",
  "goal": "Keep this workspace loop-ready and detect obvious drift.",
  "level": "L1",
  "mode": "report-only",
  "maxRuntimeMs": 120000,
  "breaker": {
    "maxConsecutiveFailures": 3,
    "sameFailureThreshold": 2
  },
  "checks": [
    {
      "id": "git-status",
      "type": "command",
      "cmd": "git status --short",
      "expectExitCode": 0,
      "timeoutMs": 10000
    }
  ]
}
```

Supported check types:

- `files`: assert relative paths exist.
- `command`: run a shell command and compare its exit code.

## Observability

Use read-only diagnostics before changing loop configs or queue state:

```bash
loop-engineering doctor --root /path/to/workspace
loop-engineering doctor --root /path/to/workspace --json
```

`doctor` checks the workspace root, loop configs, queue configs, runtime
directories, latest loop outcomes, queue status, active tasks, failed tasks, and
active queue locks. Warnings do not fail the command; hard config/runtime
errors exit non-zero.

Use `summarize` when the user asks how a loop or queue has been doing:

```bash
loop-engineering summarize --root /path/to/workspace --limit 20
loop-engineering summarize --root /path/to/workspace --id workspace-health
loop-engineering summarize --root /path/to/workspace --queue agent-tasks
```

`summarize` reports inspected/readable/skipped runs, status counts, success
rate, average duration, latest matching run, and recent failure reasons. Use
`--id` for loop-spec runs and `--queue` for queue-dispatch runs.

## Queue Runner

Use queue commands only for explicit loop-managed handoffs, not ordinary chat.

Create a queue config first when one does not exist:

```bash
loop-engineering queue-init --root /path/to/workspace --queue agent-tasks
```

Queue configs live under `configs/loops/queues/<queue>.json` and can define:

```json
{
  "queue": "agent-tasks",
  "dispatcher": "node scripts/dispatch-task.mjs",
  "preflightConfig": "configs/loops/workspace-health.json",
  "timeoutMs": 1800000,
  "leaseMs": 1860000,
  "staleActiveMs": 3600000,
  "retry": {
    "maxAttempts": 1,
    "retryDelayMs": 0,
    "retryExitCodes": [1]
  }
}
```

```bash
loop-engineering enqueue \
  --root /path/to/workspace \
  --queue agent-tasks \
  --title "Check target app logs" \
  --task "Inspect the latest logs and summarize blockers."
```

```bash
loop-engineering run-queue \
  --root /path/to/workspace \
  --config configs/loops/queues/agent-tasks.json
```

The dispatcher receives `LOOP_TASK_ID`, `LOOP_TASK_TITLE`, `LOOP_TASK_BODY`,
`LOOP_TASK_FILE`, `LOOP_TASK_FILE_REL`, `LOOP_QUEUE_ID`, `LOOP_RUN_ID`,
`LOOP_ATTEMPT`, and `LOOP_MAX_ATTEMPTS`.
Keep dispatcher commands local to the target workspace and do not put private
machine paths into public package templates.

Use `queue-peek` before changing a queue by hand. Use `queue-cancel` to move a
queued task to `canceled/`, and `queue-requeue` to move a failed, active, or
canceled task back to `inbox/`. `run-queue` uses a lease lock to prevent
overlapping ticks and can move stale active tasks to `failed/` using
`staleActiveMs`.

Queue artifacts live under:

```text
runtime/loops/<queue>/inbox/
runtime/loops/<queue>/active/
runtime/loops/<queue>/done/
runtime/loops/<queue>/failed/
runtime/loops/<queue>/canceled/
runtime/loops/<queue>/runs/
```

## Assisted Code Worktrees

Use code worktree queues only for explicit L2 code-changing tasks, and keep
human review in the loop. The runner prepares local changes; it does not push,
merge, or delete worktrees.

Create a starter config:

```bash
loop-engineering code-queue-init --root /path/to/workspace --queue code-tasks
```

The generated queue config enables:

```json
{
  "worktree": {
    "enabled": true,
    "baseDir": "runtime/loops/code-tasks/worktrees",
    "branchPrefix": "loop/code-tasks",
    "verifyCommands": ["npm test"],
    "keepOnSuccess": true
  }
}
```

When `worktree.enabled` is true, `run-queue` creates a git worktree and branch
for the task, runs the dispatcher with cwd set to that worktree, runs
`verifyCommands`, then records the branch, worktree path, verification results,
`git status --short`, `git diff --stat`, and `git diff --name-status` in the
run artifact, plus untracked file names.

The dispatcher receives the normal queue environment plus `LOOP_ROOT`,
`LOOP_WORKTREE_PATH`, `LOOP_WORKTREE_PATH_REL`, and `LOOP_WORKTREE_BRANCH`.

Inspect code worktree artifacts without changing git state:

```bash
loop-engineering code-worktree-list --root /path/to/workspace --queue code-tasks
loop-engineering code-worktree-inspect --root /path/to/workspace --queue code-tasks --task-id <id>
loop-engineering code-worktree-inspect --root /path/to/workspace --queue code-tasks --run-id <id> --json
loop-engineering code-worktree-diff --root /path/to/workspace --queue code-tasks --task-id <id>
loop-engineering code-worktree-diff --root /path/to/workspace --queue code-tasks --run-id <id> --json
loop-engineering code-worktree-export --root /path/to/workspace --queue code-tasks --task-id <id>
loop-engineering code-worktree-export --root /path/to/workspace --queue code-tasks --run-id <id> --output review.patch --json
loop-engineering code-patch-verify --root /path/to/workspace --patch runtime/loops/code-tasks/patches/<id>.patch
loop-engineering code-patch-verify --root /path/to/workspace --patch review.patch --json
```

These commands report branch, path, dirty status, verification status, diff
summaries, and untracked files from queue run artifacts. `code-worktree-diff`
resolves the recorded worktree and prints the actual patch plus untracked file
names for review. `code-worktree-export` writes the patch plus a JSON manifest
under `runtime/loops/<queue>/patches/` by default and refuses to overwrite
unless `--force` is set. `code-patch-verify` reads an exported patch, strips
loop-engineering metadata comments, and runs `git apply --check --binary` from
the workspace root to confirm the patch still applies. They do not remove
worktrees, checkout, stage, commit, push, merge, or change git state.

## Operating Flow

1. Read the existing loop docs and configs in the target workspace.
2. Add or edit the smallest `configs/loops/<id>.json` or queue dispatcher needed.
3. Run `loop-engineering verify --config ...` for loop specs.
4. Run one manual tick with `loop-engineering run --config ...` or `loop-engineering run-queue ...`.
5. Inspect `runtime/loops/<id>/runs/*.json` or `runtime/loops/<queue>/runs/*.json` before summarizing.
6. Run `loop-engineering doctor --root ...` after changing queue or loop configuration.
7. Add cron only after a manual run succeeds.

## Cron

Use a command cron that executes one tick. Keep success silent and notify only
on non-zero exit or breaker escalation.

Example:

```bash
openclaw cron add \
  --name "workspace-health" \
  --every 1h \
  --command "LOOP_WORKDIR=/path/to/workspace run-loop-cron.sh configs/loops/workspace-health.json" \
  --command-cwd "/path/to/workspace" \
  --timeout-seconds 180 \
  --no-output-timeout-seconds 120 \
  --output-max-bytes 20000 \
  --no-deliver
```

## Artifacts

Loop state and ledgers live under:

```text
runtime/loops/<loop_id>/state.json
runtime/loops/<loop_id>/runs/*.json
```

Summaries should cite the latest run path, outcome, failed checks, breaker
reason, and verification performed. Do not put raw noisy run logs into durable
memory; only save distilled operational facts.
