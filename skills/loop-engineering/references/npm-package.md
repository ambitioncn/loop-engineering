# npm Package

Package name: `agent-loop-engineering`
Version: `0.2.0`

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
loop-engineering run-queue --root /path/to/workspace --queue <queue> --dispatcher "command"
loop-engineering queue-status --root /path/to/workspace --queue <queue>
agent-loop status --root /path/to/workspace
LOOP_WORKDIR=/path/to/workspace run-loop-cron.sh configs/loops/<id>.json
```

The package contains `bin/`, `lib/`, `scripts/`, `templates/`, and
`skills/loop-engineering/`.
