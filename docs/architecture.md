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
- cron wrapper that stays silent on success and surfaces non-zero exits
- bundled skill that teaches agents when to use the loop workflow

## Levels

- `L1`: report-only. May run read-only checks and write local run artifacts.
- `L2`: assisted action. Intended for future isolated worktree edits.
- `L3`: unattended-capable. Intended for future explicit allowlists,
  verification budgets, human gates, and proven run history.

The current runner is designed around `L1`. Specs may declare higher levels for
planning, but stronger action policies should be implemented outside this v0
runner until appropriate gates exist.

## Artifacts

Each loop stores state and runs under the target workspace:

```text
runtime/loops/<loop_id>/state.json
runtime/loops/<loop_id>/runs/*.json
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
