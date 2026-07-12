# npm Package

Package name: `agent-loop-engineering`
Version: `0.3.4`

Install from npm:

```bash
npm install -g agent-loop-engineering
```

Installed commands:

```bash
loop-engineering init --root /path/to/workspace
loop-engineering verify --root /path/to/workspace
loop-engineering run --root /path/to/workspace --config configs/loops/<id>.json
loop-engineering status --root /path/to/workspace
loop-engineering doctor --root /path/to/workspace
loop-engineering summarize --root /path/to/workspace --limit 20
loop-engineering enqueue --root /path/to/workspace --queue <queue> --title "Title" --task "Task body"
loop-engineering queue-init --root /path/to/workspace --queue <queue>
loop-engineering code-queue-init --root /path/to/workspace --queue <queue>
loop-engineering run-queue --root /path/to/workspace --config configs/loops/queues/<queue>.json
loop-engineering queue-status --root /path/to/workspace --queue <queue>
loop-engineering queue-peek --root /path/to/workspace --queue <queue>
loop-engineering queue-cancel --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering queue-requeue --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-worktree-list --root /path/to/workspace --queue <queue>
loop-engineering code-worktree-inspect --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-worktree-diff --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-worktree-export --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering code-patch-verify --root /path/to/workspace --patch runtime/loops/<queue>/patches/<id>.patch
agent-loop status --root /path/to/workspace
LOOP_WORKDIR=/path/to/workspace run-loop-cron.sh configs/loops/<id>.json
```

`code-queue-init` creates an L2 assisted code queue config. Each task runs in
an isolated git worktree and branch, then runs configured verification commands
and records diff/status summaries. It does not push, merge, or delete
worktrees.

`code-worktree-list`, `code-worktree-inspect`, `code-worktree-diff`,
`code-worktree-export`, and `code-patch-verify` are review commands for code
queues. They report branch, path, dirty status, verification status, diff
summaries, patch output, exported patch artifacts, untracked files, and whether
an exported patch still passes `git apply --check --binary`.

The package contains `bin/`, `lib/`, `scripts/`, `templates/`, and
`skills/loop-engineering/`.
