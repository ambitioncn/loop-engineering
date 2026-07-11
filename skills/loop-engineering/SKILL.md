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

## Operating Flow

1. Read the existing loop docs and configs in the target workspace.
2. Add or edit the smallest `configs/loops/<id>.json` needed.
3. Run `loop-engineering verify --config ...`.
4. Run one manual tick with `loop-engineering run --config ...`.
5. Inspect `runtime/loops/<id>/runs/*.json` before summarizing.
6. Add cron only after a manual run succeeds.

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
