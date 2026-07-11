# Agent Loop Engineering

OpenClaw-native loop engineering for repeated agent work. It provides a small
Node CLI that executes JSON loop specs, records append-only run artifacts, and
uses a circuit breaker to escalate repeated failures.

The core idea is deliberately simple:

```text
Trigger -> Load state -> Check -> Verify -> Record -> Stop or schedule next run
```

The first release is conservative by design. It is best suited for report-only
health checks, repeatable preflights, and cron-driven monitoring where every run
should leave a small local artifact.

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
```

Artifacts are written to:

```text
runtime/loops/<loop_id>/state.json
runtime/loops/<loop_id>/runs/*.json
```

## Loop Specs

Loop specs are JSON files. A minimal report-only spec looks like this:

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
      "timeoutMs": 10000,
      "allowNonEmptyOutput": true
    }
  ]
}
```

Supported check types:

- `files`: asserts that relative paths exist.
- `command`: runs a shell command and compares its exit code.

## Cron Wrapper

Use the bundled wrapper after installing the package:

```bash
LOOP_WORKDIR=/path/to/workspace \
  run-loop-cron.sh configs/loops/workspace-health.json
```

Set `LOOP_ALERT_COMMAND` to a command that accepts one message argument when
you want non-zero loop exits to notify a channel.

## Skill

The bundled skill is in `skills/loop-engineering/SKILL.md`. Install it from
ClawHub or copy it into an agent's skill directory when you want Codex/OpenClaw
agents to follow the loop trigger policy and operational workflow.

ClawHub:

```text
https://clawhub.ai/ambitioncn/skills/loop-engineering
```

## Repository Layout

```text
bin/                         CLI entrypoint
lib/                         runner, validation, state, and artifact logic
scripts/run-loop-cron.sh      cron-friendly wrapper
templates/workspace-health.json
skills/loop-engineering/      bundled OpenClaw/Codex skill
docs/                         architecture notes
examples/                     copyable starter specs
```

## Safety Model

- `L1` is report-only: run checks and write local artifacts.
- `L2` and `L3` are reserved for stronger future gates.
- External writes, publishing, destructive commands, credential changes, and
  production config edits should remain separately confirmed by the operator.

See `docs/architecture.md` for the longer design notes.
