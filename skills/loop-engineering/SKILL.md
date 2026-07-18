---
name: loop-engineering
description: "Loop engineering CLI v0.4.1 with dev/acceptance loops and human gates."
---

# Loop Engineering

Use this skill when a user explicitly asks to use loop engineering, says `走 loop`,
asks to enqueue a task into a loop-managed runner, or wants a repeated agent task
wrapped with preflight, verification, local artifacts, and escalation rules.

## Default Policy

- Do not route ordinary chat or simple tasks into loop engineering.
- Route only when the user explicitly says `走 loop`, `loop engineering`,
  `丢进 <queue> loop`, `走 task-runner`, or otherwise names a loop queue.
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
loop-engineering queue-revision-next --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering queue-lineage --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering queue-lineage-bundle --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering queue-human-decision --root /path/to/workspace --queue <queue> --task-id <id> --decision approve|request_changes|reject
loop-engineering code-queue-init --root /path/to/workspace --queue <queue>
loop-engineering code-worktree-list --root /path/to/workspace --queue <queue>
loop-engineering code-worktree-inspect --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-worktree-diff --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-worktree-export --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-patch-verify --root /path/to/workspace --patch runtime/loops/<queue>/patches/<id>.patch
loop-engineering code-patch-apply-plan --root /path/to/workspace --patch runtime/loops/<queue>/patches/<id>.patch
loop-engineering code-patch-apply --root /path/to/workspace --patch runtime/loops/<queue>/patches/<id>.patch --confirm-apply
loop-engineering code-review-bundle --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-task-closeout --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-task-autoflow --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-task-autoflow --root /path/to/workspace --queue <queue> --all-actionable --until closeout
loop-engineering code-task-finish --root /path/to/workspace --queue <queue> --task-id <id> --confirm-apply --confirm-cleanup
loop-engineering code-task-run --root /path/to/workspace --queue <queue> --title "Title" --task "Task body" --confirm-apply --confirm-cleanup
loop-engineering code-task-dashboard --root /path/to/workspace --queue <queue>
loop-engineering code-task-status --root /path/to/workspace --queue <queue>
loop-engineering code-worktree-cleanup-plan --root /path/to/workspace --queue <queue>
loop-engineering code-worktree-cleanup --root /path/to/workspace --queue <queue> --confirm-cleanup
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
`LOOP_ATTEMPT`, `LOOP_MAX_ATTEMPTS`, `LOOP_TASK_CONTRACT_FILE`,
`LOOP_ACCEPTANCE_PLAN_FILE`, `LOOP_DEV_PLAN_FILE`, `LOOP_CHECKPOINTS_DIR`, and
`LOOP_REVIEWS_DIR`.
Keep dispatcher commands local to the target workspace and do not put private
machine paths into public package templates.

For v0.4 task runs, the queue runner writes `task_contract.json`,
`acceptance_plan.json`, `dev_plan.json`, checkpoint files, acceptance review
files, `final_judgement.json`, and `revision_request.json` when acceptance
needs another development pass under
`runtime/loops/<queue>/tasks/<task_id>/`. If acceptance needs changes, a
dispatcher-successful task is marked `needs_revision` instead of completed,
and the revision request carries compact next-round goals.

Use `queue-revision-next` for a failed `needs_revision` task when the next
development round should be enqueued without moving or overwriting the failed
source task.

`queue-revision-next` enforces the queue's `revisionPolicy` by default: up to 3
revision rounds, block when the same revision-goal signature appears in 2
consecutive rounds, and require a changed strategy or new evidence in the next
task. Use `--force` only for an explicit human override after inspecting the
lineage or bundle.

Use `queue-lineage` to inspect a task's full revision chain, including the root
task, current path, revision edges, known attempts, checkpoints, reviews, final
judgements, and revision requests.

Use `queue-lineage-bundle` to write a Markdown human review bundle and JSON
sidecar for that chain under `runtime/loops/<queue>/lineage-bundles/`.

Use `queue-human-decision` to record a human gate decision after inspecting a
task, lineage, or bundle. It writes `human_review_decision.json` with
`approve`, `request_changes`, or `reject`. `request_changes` also writes
`human_revision_request.json`, and `--enqueue-revision` can immediately queue
the next round from the human feedback.

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
loop-engineering code-patch-apply-plan --root /path/to/workspace --patch review.patch --json
loop-engineering code-patch-apply --root /path/to/workspace --patch review.patch --confirm-apply
loop-engineering code-review-bundle --root /path/to/workspace --queue code-tasks --task-id <id>
loop-engineering code-review-bundle --root /path/to/workspace --queue code-tasks --run-id <id> --output review.md --json
loop-engineering code-task-closeout --root /path/to/workspace --queue code-tasks --task-id <id>
loop-engineering code-task-closeout --root /path/to/workspace --queue code-tasks --run-id <id> --output closeout.md --json
loop-engineering code-task-autoflow --root /path/to/workspace --queue code-tasks --task-id <id>
loop-engineering code-task-autoflow --root /path/to/workspace --queue code-tasks --run-id <id> --until closeout --json
loop-engineering code-task-autoflow --root /path/to/workspace --queue code-tasks --all-actionable --until closeout --json
loop-engineering code-task-finish --root /path/to/workspace --queue code-tasks --task-id <id> --confirm-apply --confirm-cleanup
loop-engineering code-task-finish --root /path/to/workspace --queue code-tasks --run-id <id> --confirm-apply --confirm-cleanup --json
loop-engineering code-task-run --root /path/to/workspace --queue code-tasks --title "Title" --task "Task body" --confirm-apply --confirm-cleanup
loop-engineering code-task-dashboard --root /path/to/workspace --queue code-tasks
loop-engineering code-task-dashboard --root /path/to/workspace --queue code-tasks --json
loop-engineering code-task-status --root /path/to/workspace --queue code-tasks
loop-engineering code-task-status --root /path/to/workspace --queue code-tasks --task-id <id> --json
loop-engineering code-worktree-cleanup-plan --root /path/to/workspace --queue code-tasks
loop-engineering code-worktree-cleanup-plan --root /path/to/workspace --queue code-tasks --json
loop-engineering code-worktree-cleanup --root /path/to/workspace --queue code-tasks --confirm-cleanup
loop-engineering code-worktree-cleanup --root /path/to/workspace --queue code-tasks --confirm-cleanup --include-orphans --json
```

These commands report branch, path, dirty status, verification status, diff
summaries, and untracked files from queue run artifacts. `code-worktree-diff`
resolves the recorded worktree and prints the actual patch plus untracked file
names for review. `code-worktree-export` writes the patch plus a JSON manifest
under `runtime/loops/<queue>/patches/` by default and refuses to overwrite
unless `--force` is set. `code-patch-verify` reads an exported patch, strips
loop-engineering metadata comments, and runs `git apply --check --binary` from
the workspace root to confirm the patch still applies. `code-patch-apply-plan`
is read-only and reports whether the patch can be safely applied, including
dirty affected files. `code-patch-apply` requires `--confirm-apply`, reruns the
plan, and applies only when the plan is ready. `code-review-bundle` writes a
Markdown review artifact plus JSON sidecar with run identity, worktree summary,
verification, diff, patch export status, patch verify, and apply-plan status.
`code-worktree-cleanup-plan`
reports missing worktrees, dirty worktrees that have not been exported, rejected
patch exports, orphan worktree directories, and suggested cleanup commands.
`code-worktree-cleanup` requires `--confirm-cleanup`, reruns the cleanup plan,
and removes only gated candidates with `git worktree remove`. Dirty worktrees
must have a default exported patch, passing patch verification, and an existing
review bundle Markdown plus JSON sidecar. Orphan worktrees are skipped unless
`--include-orphans` is supplied. `doctor` reports the same code queue findings
as warnings. `code-task-closeout` writes a Markdown closeout artifact plus JSON
sidecar with task/run identity, verification, patch export/verify/apply-plan
status, review presence, cleanup recommendation, and remaining next actions.
`code-task-autoflow` is a safe orchestration command that runs the review
preparation flow through export, patch verification, apply-plan, and review
bundle generation by default. With `--until closeout`, it also writes the
closeout artifact. It skips existing patch/review/closeout artifacts unless
`--force` is supplied. With `--all-actionable`, it reads `code-task-status` and
runs the same safe flow across tasks whose next actions require export, review,
or closeout generation; custom output paths are disabled in batch mode.
`code-task-status` is a read-only task ledger that reports queue state, worktree
existence, patch/review/closeout/finish presence, cleanup recommendation,
aggregate counts, and next recommended commands. It reports `ready_to_finish`
when a task has the required review and closeout artifacts plus a ready cleanup
gate, and `landed` after a successful finish artifact exists. Planning, status,
and closeout commands do not remove worktrees. `code-task-run` is the basic
end-to-end code task command: it enqueues one task, processes one code worktree
queue run, runs autoflow through closeout, finishes the reviewed task, and then
reruns the queue's `worktree.verifyCommands` in the main workspace. It requires
`--confirm-apply` and `--confirm-cleanup`, and stops with artifact pointers if
any stage fails. `code-task-dashboard` is a read-only queue dashboard that
combines queue counts, task ledger counts, action counts, cleanup/orphan
summaries, ready-to-finish and landed task buckets, priority tasks, and
recommended follow-up commands. Autoflow does not apply patches, remove
worktrees, or change queue state. `code-task-finish` is a single-task,
confirmation-gated landing command: it requires default patch, review, and
closeout artifacts, verifies the apply plan and cleanup gate, applies the patch
to the main workspace, removes that one reviewed worktree, and writes a finish
artifact. It intentionally has no batch mode and does not stage, commit, push,
merge, delete branches, or change queue state. Cleanup does not checkout, stage,
commit, push, merge, delete branches, or change queue state.

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
