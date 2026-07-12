# OpenClaw Loop Engineering

Loop engineering wraps repeated agent work in a small, inspectable cycle:

```text
Trigger -> Load state -> Sense -> Choose -> Act/Check -> Verify -> Record -> Stop or schedule next run
```

This package implements the conservative foundation of that idea for OpenClaw
and Codex-style agents:

- deterministic CLI runner, no hidden model call
- JSON loop specs
- local state and append-only run artifacts
- command and file checks
- circuit breaker for repeated failures
- generic queue runner for explicit task handoffs
- assisted code queues that isolate edits in git worktrees
- cron wrapper that stays silent on success and surfaces non-zero exits
- bundled skill that teaches agents when to use the loop workflow

## Levels

- `L1`: report-only. May run read-only checks and write local run artifacts.
- `L2`: assisted action. May prepare local changes in isolated worktrees,
  run verification, and leave artifacts for human review.
- `L3`: unattended-capable. Intended for future explicit allowlists,
  verification budgets, human gates, and proven run history.

The loop-spec runner remains designed around `L1`. The queue runner supports a
bounded `L2` mode through `worktree.enabled`: it creates local worktrees and
records evidence, but it does not push, merge, delete worktrees, or perform
external writes.

## Queue Runner

`v0.2.0` added a durable queue for explicit loop-managed task handoffs:

```bash
loop-engineering enqueue \
  --queue agent-tasks \
  --title "Check target app logs" \
  --task "Inspect the latest logs and summarize blockers."
```

```bash
loop-engineering run-queue \
  --queue agent-tasks \
  --preflight-config configs/loops/workspace-health.json \
  --dispatcher "node scripts/dispatch-task.mjs" \
  --timeout-ms 1800000
```

The dispatcher is deliberately external to the package. It receives task data
through environment variables such as `LOOP_TASK_BODY`, `LOOP_TASK_FILE`, and
`LOOP_RUN_ID`, so each workspace can decide how to hand off work without baking
private machine paths or credentials into public templates.

## Code Worktree Queue

`v0.3.0` adds assisted code queues:

```bash
loop-engineering code-queue-init --queue code-tasks
loop-engineering enqueue --queue code-tasks --title "Fix parser" --task "Patch the parser and run tests."
loop-engineering run-queue --config configs/loops/queues/code-tasks.json
```

When `worktree.enabled` is true, the runner:

1. Runs the optional preflight loop in the main workspace.
2. Creates `git worktree add -b <branch> <path> HEAD`.
3. Runs the dispatcher with cwd set to the worktree.
4. Runs configured `verifyCommands`.
5. Records branch, worktree path, verification results, git status, diff
   summaries, and untracked files in the run artifact.

This keeps code-changing work reviewable without giving the loop authority to
ship changes.

`v0.3.1` adds read-only worktree artifact inspection:

```bash
loop-engineering code-worktree-list --queue code-tasks
loop-engineering code-worktree-inspect --queue code-tasks --task-id <id>
```

These commands summarize the recorded branch, path, dirty state, verification
status, diff summaries, and untracked files. They do not remove worktrees or
change git state.

## Artifacts

Loop specs store state and runs under the target workspace:

```text
runtime/loops/<loop_id>/state.json
runtime/loops/<loop_id>/runs/*.json
```

Queue runs use:

```text
runtime/loops/<queue>/inbox/
runtime/loops/<queue>/active/
runtime/loops/<queue>/done/
runtime/loops/<queue>/failed/
runtime/loops/<queue>/canceled/
runtime/loops/<queue>/runs/
runtime/loops/<queue>/worktrees/
```

Run artifacts are meant to be compact evidence, not raw logs. Long-term memory
or external summaries should keep only distilled facts, such as recurring
failure signatures, accepted human gates, or a loop's current health status.

## Cron Pattern

Install the package globally, then run one tick from cron or a scheduler:

```bash
LOOP_WORKDIR=/path/to/workspace \
  run-loop-cron.sh configs/loops/workspace-health.json
```

Set `LOOP_ALERT_COMMAND` to a command that accepts one message argument if your
environment should send an alert when the runner exits non-zero.
