# npm Package

Package name: `agent-loop-engineering`
Version: `0.2.1`

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
loop-engineering enqueue --root /path/to/workspace --queue <queue> --title "Title" --task "Task body"
loop-engineering queue-init --root /path/to/workspace --queue <queue>
loop-engineering run-queue --root /path/to/workspace --config configs/loops/queues/<queue>.json
loop-engineering queue-status --root /path/to/workspace --queue <queue>
loop-engineering queue-peek --root /path/to/workspace --queue <queue>
loop-engineering queue-cancel --root /path/to/workspace --queue <queue> --task-id <id>
loop-engineering queue-requeue --root /path/to/workspace --queue <queue> --task-id <id>
agent-loop status --root /path/to/workspace
LOOP_WORKDIR=/path/to/workspace run-loop-cron.sh configs/loops/<id>.json
```

The package contains `bin/`, `lib/`, `scripts/`, `templates/`, and
`skills/loop-engineering/`.
