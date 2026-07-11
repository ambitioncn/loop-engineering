# npm Package

Package name: `agent-loop-engineering`
Version: `0.1.0`

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
agent-loop status --root /path/to/workspace
LOOP_WORKDIR=/path/to/workspace run-loop-cron.sh configs/loops/<id>.json
```

The package contains `bin/`, `lib/`, `scripts/`, `templates/`, and
`skills/loop-engineering/`.
