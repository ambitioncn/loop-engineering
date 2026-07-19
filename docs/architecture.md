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

## Dev / Acceptance Split

The next queue architecture for non-trivial tasks is a two-team loop:

```text
Task intake
  -> task contract
  -> acceptance plan + development plan
  -> development checkpoint
  -> acceptance review
  -> development revision
  -> final judge
  -> report / gate / apply
```

Development owns implementation and local evidence. Acceptance owns proof:
functional checks, regression checks, edge cases, negative tests, manual review,
and automation suggestions. The final judge is separate from both and verifies
that the result still matches the original task contract and risk gates.

The important artifact names are:

```text
task_contract.json
acceptance_plan.json
dev_plan.json
checkpoint_review.json
final_judgement.json
```

This model should fit on top of the current queue runner rather than replace
it. The queue still owns leases, preflight, active/done/failed state, and run
artifacts; the task subdirectory owns multi-round collaboration evidence.

`v0.4` starts with deterministic planning artifacts. `run-queue` writes
`runtime/loops/<queue>/tasks/<task_id>/task_contract.json`,
`acceptance_plan.json`, `dev_plan.json`, `checkpoints/`, and `reviews/` before
preflight and dispatch, then writes `final_judgement.json` after acceptance
review and `revision_request.json` when the final judgement needs another
development pass. It exposes the planning directories to the dispatcher as
`LOOP_TASK_CONTRACT_FILE`, `LOOP_ACCEPTANCE_PLAN_FILE`, `LOOP_DEV_PLAN_FILE`,
`LOOP_CHECKPOINTS_DIR`, and `LOOP_REVIEWS_DIR`, then records the contract path,
inferred risk level, human-gate flag, acceptance plan path, check counts, dev
plan path, planned checkpoint count, produced checkpoint files, and acceptance
review files, final judgement outcome, and revision request summary in the run
artifact. A completed dispatch whose acceptance review still needs changes is
marked `needs_revision` instead of completed.

`queue-revision-next` turns a failed `needs_revision` task into a fresh queued
revision task using `revision_request.json`. It preserves the failed source
task and run artifacts, then embeds the revision goals and next checkpoint id
in the new task body.

`revisionPolicy` is checked at this handoff point so persistence does not become
mechanical repetition. The default policy allows up to 3 revision rounds and
blocks another next-round enqueue when two consecutive attempts have the same
revision-goal signature. Revision task bodies include anti-loop instructions
requiring the next agent to change diagnosis, tactic, evidence, or verification;
a human can still override the guard with `queue-revision-next --force`.

`queue-lineage` is the read-only attempt graph view. It can start from any task
in the chain and returns the root task id, current path, revision edges, known
attempts, checkpoint/review summaries, final judgement outcomes, and revision
request status. Every queue run artifact also embeds the same lineage summary
after the task is moved to its final state.

`queue-lineage-bundle` renders that attempt graph into a Markdown human review
bundle and JSON sidecar under `runtime/loops/<queue>/lineage-bundles/`. The
bundle is intended for handoff: it summarizes what changed in each round, why
acceptance failed, how the next round was requested, and whether the latest
round is ready for human review.

`queue-human-decision` is the explicit human gate. It records `approve`,
`request_changes`, or `reject` in
`runtime/loops/<queue>/tasks/<task_id>/human_review_decision.json`. When the
decision is `request_changes`, it also writes `human_revision_request.json`
with the human feedback converted into revision goals. `queue-revision-next`
can use that human request to create the next round, so mid-project feedback is
tracked as first-class lineage rather than lost in chat. The dispatcher also
receives `LOOP_HUMAN_REVIEW_DECISION_FILE` and
`LOOP_HUMAN_REVISION_REQUEST_FILE`, so long-running development agents can
poll for human feedback while the task is still active.

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

Queue command execution uses an isolated process group. When a dispatcher,
preflight, or verification command times out, the runner sends SIGTERM and then
SIGKILL to the whole process group so child processes do not survive the failed
run. This matters for device and instrumentation work where a shell wrapper may
spawn long-lived `adb`, `frida`, `tcpdump`, or proxy processes.

Dispatcher retry is also failure-aware. The queue `retry` config can list
`requiresHumanActionPatterns`; matching output marks the run
`needs_human_input` and stops retry. Defaults cover common device authorization,
permission, and explicit human-approval blockers, including
`INSTALL_FAILED_USER_RESTRICTED`. These states are treated as blocked human
gates rather than development failures, so `queue-revision-next` does not turn a
phone permission prompt into repeated automated attempts.

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

`v0.3.2` adds read-only patch review:

```bash
loop-engineering code-worktree-diff --queue code-tasks --task-id <id>
loop-engineering code-worktree-diff --queue code-tasks --run-id <id> --json
```

The command resolves the recorded worktree path from the run artifact, keeps it
inside the workspace root, and prints `git diff --stat HEAD`, `git diff
--name-status HEAD`, `git diff --binary HEAD`, and untracked file names. It
does not checkout, stage, commit, push, merge, delete, or modify queue state.

`v0.3.3` adds durable patch export artifacts:

```bash
loop-engineering code-worktree-export --queue code-tasks --task-id <id>
loop-engineering code-worktree-export --queue code-tasks --run-id <id> --output review.patch --json
```

The command writes a patch file plus JSON manifest for the recorded worktree.
By default the files go under `runtime/loops/<queue>/patches/`, and existing
exports are not overwritten unless `--force` is set. This gives humans and
follow-up tools a stable review artifact while still avoiding checkout, stage,
commit, push, merge, deletion, or queue-state changes.

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
