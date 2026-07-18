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
loop-engineering queue-revision-next --queue agent-tasks --task-id <id>
loop-engineering queue-lineage --queue agent-tasks --task-id <id>
loop-engineering queue-lineage-bundle --queue agent-tasks --task-id <id>
loop-engineering queue-human-decision --queue agent-tasks --task-id <id> --decision approve|request_changes|reject
loop-engineering code-worktree-list --queue code-tasks
loop-engineering code-worktree-inspect --queue code-tasks --task-id <id>
loop-engineering code-worktree-diff --queue code-tasks --task-id <id>
loop-engineering code-worktree-export --queue code-tasks --task-id <id>
loop-engineering code-patch-verify --patch runtime/loops/code-tasks/patches/<id>.patch
loop-engineering code-patch-apply-plan --patch runtime/loops/code-tasks/patches/<id>.patch
loop-engineering code-patch-apply --patch runtime/loops/code-tasks/patches/<id>.patch --confirm-apply
loop-engineering code-review-bundle --queue code-tasks --task-id <id>
loop-engineering code-task-closeout --queue code-tasks --task-id <id>
loop-engineering code-task-autoflow --queue code-tasks --task-id <id>
loop-engineering code-task-autoflow --queue code-tasks --all-actionable --until closeout
loop-engineering code-task-finish --queue code-tasks --task-id <id> --confirm-apply --confirm-cleanup
loop-engineering code-task-run --queue code-tasks --title "Task" --task "Do the work" --confirm-apply --confirm-cleanup
loop-engineering code-task-dashboard --queue code-tasks
loop-engineering code-task-status --queue code-tasks
loop-engineering code-worktree-cleanup-plan --queue code-tasks
loop-engineering code-worktree-cleanup --queue code-tasks --confirm-cleanup
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
  },
  "revisionPolicy": {
    "enabled": true,
    "maxRevisionRounds": 3,
    "sameFailureThreshold": 2,
    "requireStrategyChange": true
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
LOOP_TASK_RUNTIME_DIR
LOOP_TASK_RUNTIME_DIR_REL
LOOP_TASK_CONTRACT_FILE
LOOP_TASK_CONTRACT_FILE_REL
LOOP_ACCEPTANCE_PLAN_FILE
LOOP_ACCEPTANCE_PLAN_FILE_REL
LOOP_DEV_PLAN_FILE
LOOP_DEV_PLAN_FILE_REL
LOOP_CHECKPOINTS_DIR
LOOP_CHECKPOINTS_DIR_REL
LOOP_REVIEWS_DIR
LOOP_REVIEWS_DIR_REL
LOOP_HUMAN_REVIEW_DECISION_FILE
LOOP_HUMAN_REVIEW_DECISION_FILE_REL
LOOP_HUMAN_REVISION_REQUEST_FILE
LOOP_HUMAN_REVISION_REQUEST_FILE_REL
LOOP_RUN_ID
LOOP_ATTEMPT
LOOP_MAX_ATTEMPTS
```

Before dispatch, `run-queue` writes planning artifacts under
`runtime/loops/<queue>/tasks/<task_id>/`: `task_contract.json`,
`acceptance_plan.json`, `dev_plan.json`, `checkpoints/`, `reviews/`, and
`final_judgement.json`; when acceptance requires more work, it also writes
`revision_request.json`. The dispatcher can
read them through `LOOP_TASK_CONTRACT_FILE`, `LOOP_ACCEPTANCE_PLAN_FILE`,
`LOOP_DEV_PLAN_FILE`, `LOOP_CHECKPOINTS_DIR`, and `LOOP_REVIEWS_DIR`; the queue
run artifact records their paths, inferred risk level, human-gate flag,
acceptance check counts, planned checkpoint count, produced checkpoint files,
generated acceptance reviews, final judgement outcome, and revision request
summary. It also records a `lineage` summary so later rounds can see the root
task, current path, revision edges, and each known attempt's checkpoint,
review, final judgement, and revision request status.

`queue-lineage-bundle` turns that lineage into a human-readable Markdown review
bundle plus a JSON sidecar under `runtime/loops/<queue>/lineage-bundles/`.
The bundle highlights what each round produced, why acceptance failed, what the
next revision requested, and whether the latest round is ready for human review.

`queue-human-decision` records the human gate for a task under
`runtime/loops/<queue>/tasks/<task_id>/human_review_decision.json`. Decisions
are `approve`, `request_changes`, or `reject`. A `request_changes` decision
also writes `human_revision_request.json`, and `--enqueue-revision` can create
the next queued revision task from that feedback.

`queue-revision-next` creates a fresh queued task from a failed task whose final
judgement is `needs_revision`. It reads `revision_request.json`, embeds the
revision goals in the new task body, and preserves the failed source task and
artifacts. It can also use `human_revision_request.json` after a human
`request_changes` decision.

`revisionPolicy` keeps the loop persistent without letting it repeat the same
failed approach forever. By default, a lineage can create up to 3 revision
rounds. If two consecutive rounds produce the same revision-goal signature,
`queue-revision-next` refuses to enqueue another automatic round. The generated
revision task also includes anti-loop instructions requiring a changed
diagnosis, implementation tactic, evidence source, or verification step. Use
`queue-lineage-bundle` and a human decision when the guard stops progress;
`queue-revision-next --force` is reserved for explicit human overrides.

Operational commands:

```bash
loop-engineering queue-status --config configs/loops/queues/agent-tasks.json
loop-engineering queue-peek --config configs/loops/queues/agent-tasks.json
loop-engineering queue-cancel --config configs/loops/queues/agent-tasks.json --task-id <id>
loop-engineering queue-requeue --config configs/loops/queues/agent-tasks.json --task-id <id>
loop-engineering queue-revision-next --config configs/loops/queues/agent-tasks.json --task-id <id>
loop-engineering queue-lineage --config configs/loops/queues/agent-tasks.json --task-id <id>
loop-engineering queue-lineage-bundle --config configs/loops/queues/agent-tasks.json --task-id <id>
loop-engineering queue-human-decision --config configs/loops/queues/agent-tasks.json --task-id <id> --decision approve
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

`v0.3.1` adds read-only worktree artifact inspection:

```bash
loop-engineering code-worktree-list --queue code-tasks
loop-engineering code-worktree-inspect --queue code-tasks --task-id <id>
loop-engineering code-worktree-inspect --queue code-tasks --run-id <id> --json
```

These commands read queue run artifacts and report branch, path, dirty status,
verification status, diff summaries, and untracked files. They do not remove
worktrees or change git state.

`v0.3.2` adds read-only patch review from the recorded worktree:

```bash
loop-engineering code-worktree-diff --queue code-tasks --task-id <id>
loop-engineering code-worktree-diff --queue code-tasks --run-id <id> --json
```

It resolves the worktree from the run artifact, keeps the path inside the
workspace root, then prints `git diff --stat HEAD`, `git diff --name-status
HEAD`, `git diff --binary HEAD`, and untracked file names. It does not stage,
commit, push, merge, delete, or checkout anything.

`v0.3.3` adds patch export artifacts:

```bash
loop-engineering code-worktree-export --queue code-tasks --task-id <id>
loop-engineering code-worktree-export --queue code-tasks --run-id <id> --output review.patch --json
```

By default it writes `runtime/loops/<queue>/patches/<taskId>.patch` plus a
`.json` manifest containing source run, worktree, diff summary, and untracked
file names. It refuses to overwrite existing exports unless `--force` is set
and does not change git or queue state.

`v0.3.4` adds offline patch verification:

```bash
loop-engineering code-patch-verify --patch runtime/loops/code-tasks/patches/<taskId>.patch
loop-engineering code-patch-verify --patch review.patch --json
```

It reads an exported patch, strips loop-engineering metadata comments, and runs
`git apply --check --binary` from the target workspace root. This verifies
whether the patch still applies without staging, committing, checking out,
merging, or changing queue state.

`v0.3.5` adds code worktree maintenance planning:

```bash
loop-engineering code-worktree-cleanup-plan --queue code-tasks
loop-engineering code-worktree-cleanup-plan --queue code-tasks --json
```

It inspects recent code queue run artifacts, checks whether recorded worktrees
still exist, detects dirty worktrees without exported patches, verifies default
patch exports when present, and reports orphan worktree directories under the
configured worktree base directory. It only prints recommendations and cleanup
commands; it does not remove worktrees or change git/queue state. `doctor`
also reports these code queue findings as warnings.

`v0.3.6` adds confirmation-gated patch application:

```bash
loop-engineering code-patch-apply-plan --patch runtime/loops/code-tasks/patches/<taskId>.patch
loop-engineering code-patch-apply --patch runtime/loops/code-tasks/patches/<taskId>.patch --confirm-apply
```

`code-patch-apply-plan` is read-only. It strips loop-engineering metadata,
checks `git apply --check --binary`, reports affected files, and blocks when
those affected files are already dirty unless `--allow-dirty` is supplied.
`code-patch-apply` requires `--confirm-apply` and runs the same plan first; it
only applies the patch when the plan is ready. It does not stage, commit, push,
merge, checkout, delete worktrees, or change queue state.

`v0.3.7` adds review bundle artifacts:

```bash
loop-engineering code-review-bundle --queue code-tasks --task-id <taskId>
loop-engineering code-review-bundle --queue code-tasks --run-id <runId> --output review.md --json
```

It writes `runtime/loops/<queue>/reviews/<taskId>.md` plus a `.json` sidecar by
default. The bundle collects the task/run identity, worktree summary,
verification results, current worktree diff, exported patch presence,
`code-patch-verify`, and `code-patch-apply-plan` when a default exported patch
exists. It refuses to overwrite unless `--force` is set and does not export,
apply, stage, commit, push, merge, delete worktrees, or change queue state.

`v0.3.8` adds confirmation-gated worktree cleanup:

```bash
loop-engineering code-worktree-cleanup --queue code-tasks --confirm-cleanup
loop-engineering code-worktree-cleanup --queue code-tasks --confirm-cleanup --include-orphans --json
```

It reruns `code-worktree-cleanup-plan` and removes only gated candidates with
`git worktree remove`. Dirty worktrees require a default exported patch,
successful `code-patch-verify`, and an existing review bundle Markdown plus
JSON sidecar. Orphan worktree directories are skipped unless `--include-orphans`
is supplied. The command does not stage, commit, push, merge, delete branches,
or change queue state.

`v0.3.9` adds closeout artifacts:

```bash
loop-engineering code-task-closeout --queue code-tasks --task-id <taskId>
loop-engineering code-task-closeout --queue code-tasks --run-id <runId> --output closeout.md --json
```

It writes `runtime/loops/<queue>/closeouts/<taskId>.md` plus a `.json` sidecar
by default. The closeout gathers run identity, verification, current worktree
state when present, patch export/verify/apply-plan status, review bundle
presence, cleanup recommendation, and remaining next actions. It refuses to
overwrite unless `--force` is set and does not apply patches, remove worktrees,
stage, commit, push, merge, delete branches, or change queue state.

`v0.3.10` adds a task-level status ledger:

```bash
loop-engineering code-task-status --queue code-tasks
loop-engineering code-task-status --queue code-tasks --task-id <taskId> --json
```

It reads recent code queue run artifacts and reports each task's queue state,
worktree existence, patch export and verification status, review bundle
presence, closeout status, cleanup recommendation, aggregate counts, and next
recommended commands. It is read-only and does not apply patches, remove
worktrees, stage, commit, push, merge, delete branches, or change queue state.

`v0.3.11` adds a safe code task autoflow:

```bash
loop-engineering code-task-autoflow --queue code-tasks --task-id <taskId>
loop-engineering code-task-autoflow --queue code-tasks --task-id <taskId> --until closeout --json
```

By default, `code-task-autoflow` runs the review preparation flow through
`export -> verify -> apply-plan -> review`. With `--until closeout`, it also
generates the closeout artifact. Existing patch, review, and closeout artifacts
are skipped unless `--force` is set. It does not apply patches, remove
worktrees, stage, commit, push, merge, delete branches, or change queue state.

`v0.3.12` adds batch autoflow for actionable code tasks:

```bash
loop-engineering code-task-autoflow --queue code-tasks --all-actionable
loop-engineering code-task-autoflow --queue code-tasks --all-actionable --until closeout --json
```

Batch autoflow reads `code-task-status`, selects tasks whose next actions need
patch export, review generation, or, with `--until closeout`, closeout
generation, then runs the same safe autoflow for each selected task. Custom
output paths are intentionally disabled in batch mode. It still does not apply
patches, remove worktrees, stage, commit, push, merge, delete branches, or
change queue state.

`v0.3.13` adds a read-only dashboard for code task queues:

```bash
loop-engineering code-task-dashboard --queue code-tasks
loop-engineering code-task-dashboard --queue code-tasks --json
```

The dashboard combines queue counts, task ledger counts, next-action counts,
cleanup/orphan summaries, priority tasks, and recommended follow-up commands.
It is read-only and does not apply patches, remove worktrees, stage, commit,
push, merge, delete branches, or change queue state.

`v0.3.14` adds confirmation-gated single-task finish:

```bash
loop-engineering code-task-finish --queue code-tasks --task-id <taskId> --confirm-apply --confirm-cleanup
loop-engineering code-task-finish --queue code-tasks --run-id <runId> --confirm-apply --confirm-cleanup --json
```

Finish requires default patch export/manifest, review bundle Markdown/JSON,
closeout Markdown/JSON, a ready `code-patch-apply-plan`, and a passing cleanup
gate. It then applies the patch to the main workspace and removes that one
reviewed worktree, writing `runtime/loops/<queue>/finishes/<taskId>.md` plus a
JSON sidecar. It is intentionally single-task only, requires both confirmation
flags, and still does not stage, commit, push, merge, delete branches, or
change queue state.

`v0.3.15` makes finish artifacts visible in status and dashboard views:

```bash
loop-engineering code-task-status --queue code-tasks --task-id <taskId>
loop-engineering code-task-dashboard --queue code-tasks --json
```

After closeout artifacts are present and the cleanup gate is ready, the status
ledger reports `ready_to_finish` and recommends the single-task
`code-task-finish` command. After finish succeeds, the same task reports
`landed`, includes finish artifact status, patch-applied, and worktree-cleaned
fields, and has no remaining next actions. Dashboards include landed tasks and
finish action counts. These views remain read-only.

`v0.3.16` adds a single end-to-end code task command for the basic loop
engineering workflow:

```bash
loop-engineering code-task-run \
  --queue code-tasks \
  --title "Implement the feature" \
  --task "Make the code change, update tests, and keep the package checks green." \
  --confirm-apply \
  --confirm-cleanup
```

`code-task-run` enqueues the task, processes one code worktree queue task,
runs autoflow through closeout, finishes the task by applying the reviewed
patch and cleaning that worktree, then reruns the queue's configured
`worktree.verifyCommands` in the main workspace. It stops at the first failed
stage and reports the artifact to inspect. It still requires
`--confirm-apply` and `--confirm-cleanup`, and it does not stage, commit, push,
merge, or delete branches.

`v0.4.1` adds revision persistence guards so development loops keep trying with
new evidence or strategy changes while blocking repeated identical failures.
Queue runs now create a task contract, acceptance plan, development plan,
checkpoint directory, acceptance review files, final judgement, revision
requests, lineage summaries, human review bundles, and human gate decision
records. Human reviewers can approve, reject, or request changes with
`queue-human-decision`; requested changes can be turned into the next revision
task with `--enqueue-revision`.

## Skill

The bundled skill is in `skills/loop-engineering/SKILL.md`. Install it from
ClawHub or copy it into an agent's skill directory when you want Codex/OpenClaw
agents to follow the loop trigger policy and operational workflow.

ClawHub:

```text
https://clawhub.ai/ambitioncn/skills/loop-engineering
```
