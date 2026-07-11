# Agent Loop Engineering

OpenClaw-native loop engineering for repeated agent work. It provides a small
Node CLI that executes JSON loop specs, records append-only run artifacts, and
uses a circuit breaker to escalate repeated failures.

It also includes a small durable task queue runner for explicit loop-managed
work handoffs.

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
loop-engineering enqueue --queue agent-tasks --title "Check logs" --task "Inspect the latest logs."
loop-engineering run-queue --queue agent-tasks --dispatcher "node scripts/dispatch-task.mjs"
loop-engineering queue-status --queue agent-tasks
```

Artifacts are written to:

```text
runtime/loops/<loop_id>/state.json
runtime/loops/<loop_id>/runs/*.json
```

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

```bash
loop-engineering enqueue \
  --queue agent-tasks \
  --title "Check target app logs" \
  --task "Inspect the latest logs and summarize blockers."
```

Process one task:

```bash
loop-engineering run-queue \
  --queue agent-tasks \
  --preflight-config configs/loops/workspace-health.json \
  --dispatcher "node scripts/dispatch-task.mjs" \
  --timeout-ms 1800000
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
```

Queue artifacts live under:

```text
runtime/loops/<queue>/inbox/*.json
runtime/loops/<queue>/active/*.json
runtime/loops/<queue>/done/*.json
runtime/loops/<queue>/failed/*.json
runtime/loops/<queue>/runs/*.json
```

## Skill

The bundled skill is in `skills/loop-engineering/SKILL.md`. Install it from
ClawHub or copy it into an agent's skill directory when you want Codex/OpenClaw
agents to follow the loop trigger policy and operational workflow.

ClawHub:

```text
https://clawhub.ai/ambitioncn/skills/loop-engineering
```
