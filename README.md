# Agent Loop Engineering

OpenClaw-native loop engineering for repeated agent work. It provides a small
Node CLI that executes JSON loop specs, records append-only run artifacts, and
uses a circuit breaker to escalate repeated failures.

It also includes a small durable task queue runner for explicit loop-managed
work handoffs, plus an assisted code queue mode that runs each task in an
isolated git worktree.

## Install

From npm:

```bash
npm install -g agent-loop-engineering
```

Or run without installing:

```bash
npx -p agent-loop-engineering loop-engineering --help
```

## Commands

```bash
loop-engineering init --root /path/to/workspace
loop-engineering verify --root /path/to/workspace
loop-engineering run --root /path/to/workspace --config configs/loops/workspace-health.json
loop-engineering status --root /path/to/workspace
loop-engineering doctor --root /path/to/workspace
loop-engineering summarize --root /path/to/workspace --limit 20
loop-engineering queue-init --queue agent-tasks
loop-engineering code-queue-init --queue code-tasks
loop-engineering enqueue --queue agent-tasks --title "Check logs" --task "Inspect the latest logs."
loop-engineering run-queue --config configs/loops/queues/agent-tasks.json
loop-engineering queue-status --queue agent-tasks
loop-engineering queue-peek --queue agent-tasks
loop-engineering queue-cancel --queue agent-tasks --task-id <id> --reason "not needed"
loop-engineering queue-requeue --queue agent-tasks --task-id <id>
```

Artifacts are written to:

```text
runtime/loops/<loop_id>/state.json
runtime/loops/<loop_id>/runs/*.json
```

## Observability

Use `doctor` for a read-only health view of the loop workspace:

```bash
loop-engineering doctor --root /path/to/workspace
loop-engineering doctor --root /path/to/workspace --json
```

It checks the workspace root, loop configs, queue configs, runtime directories,
latest loop outcomes, queue status, active tasks, failed tasks, and active queue
locks. It exits non-zero only on hard failures; warnings are reported but do not
fail the command.

Use `summarize` to inspect recent run artifacts:

```bash
loop-engineering summarize --root /path/to/workspace --limit 20
loop-engineering summarize --root /path/to/workspace --id workspace-health
loop-engineering summarize --root /path/to/workspace --queue agent-tasks
```

The summary reports inspected/readable/skipped run counts, status counts,
success rate, average duration, latest matching run, and recent failure reasons.
`--id` filters loop-spec runs, while `--queue` filters queue-dispatch runs.

## Cron Wrapper

Use the bundled wrapper after installing the package:

```bash
LOOP_WORKDIR=/path/to/workspace \
  run-loop-cron.sh configs/loops/workspace-health.json
```

Set `LOOP_ALERT_COMMAND` to a command that accepts one message argument when
you want non-zero loop exits to notify a channel.

## Queue Runner

The queue runner is for explicit task handoffs. It does not route ordinary chat
or simple commands by itself.

Create a queue config:

```bash
loop-engineering queue-init --queue agent-tasks
```

That writes `configs/loops/queues/agent-tasks.json`:

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
  --queue agent-tasks \
  --title "Check target app logs" \
  --task "Inspect the latest logs and summarize blockers."
```

Process one task:

```bash
loop-engineering run-queue \
  --config configs/loops/queues/agent-tasks.json
```

The dispatcher receives task details through environment variables:

```text
LOOP_QUEUE_ID
LOOP_TASK_ID
LOOP_TASK_TITLE
LOOP_TASK_BODY
LOOP_TASK_FILE
LOOP_TASK_FILE_REL
LOOP_RUN_ID
LOOP_ATTEMPT
LOOP_MAX_ATTEMPTS
```

Operational commands:

```bash
loop-engineering queue-status --config configs/loops/queues/agent-tasks.json
loop-engineering queue-peek --config configs/loops/queues/agent-tasks.json
loop-engineering queue-cancel --config configs/loops/queues/agent-tasks.json --task-id <id>
loop-engineering queue-requeue --config configs/loops/queues/agent-tasks.json --task-id <id>
```

`run-queue` uses a lease lock so overlapping cron ticks do not process the same
task. `staleActiveMs` moves abandoned active tasks to `failed/` before the next
task is processed. `retry.maxAttempts` retries dispatcher failures whose exit
code is listed in `retry.retryExitCodes`.

Queue artifacts live under:

```text
runtime/loops/<queue>/inbox/*.json
runtime/loops/<queue>/active/*.json
runtime/loops/<queue>/done/*.json
runtime/loops/<queue>/failed/*.json
runtime/loops/<queue>/canceled/*.json
runtime/loops/<queue>/runs/*.json
```

## Assisted Code Worktrees

`v0.3.0` adds L2 assisted code queues. A code queue still uses `enqueue` and
`run-queue`, but the runner creates a git worktree and branch for the task,
runs the dispatcher inside that worktree, then runs configured verification
commands. It records the branch, worktree path, verification results, `git
status --short`, `git diff --stat`, and `git diff --name-status` in the run
artifact, plus untracked file names.

Create a starter config:

```bash
loop-engineering code-queue-init --queue code-tasks
```

That writes `configs/loops/queues/code-tasks.json` with:

```json
{
  "queue": "code-tasks",
  "dispatcher": "node scripts/dispatch-code-task.mjs",
  "preflightConfig": "configs/loops/workspace-health.json",
  "worktree": {
    "enabled": true,
    "baseDir": "runtime/loops/code-tasks/worktrees",
    "branchPrefix": "loop/code-tasks",
    "verifyCommands": ["npm test"],
    "keepOnSuccess": true
  }
}
```

The dispatcher receives the normal queue environment variables plus:

```text
LOOP_ROOT
LOOP_WORKTREE_PATH
LOOP_WORKTREE_PATH_REL
LOOP_WORKTREE_BRANCH
```

The runner deliberately does not push, merge, or delete worktrees. Treat the
artifact as a prepared patch workspace for review.

## Skill

The bundled skill is in `skills/loop-engineering/SKILL.md`. Install it from
ClawHub or copy it into an agent's skill directory when you want Codex/OpenClaw
agents to follow the loop trigger policy and operational workflow.

ClawHub:

```text
https://clawhub.ai/ambitioncn/skills/loop-engineering
```
