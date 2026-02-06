---
name: contextly-init
description: Initialize Contextly session metadata tracking - creates database, configures hooks, and migrates existing session data
allowed-tools: Read, Write, Edit, Bash, Glob
---

# Contextly Initialization

You are setting up Contextly session metadata tracking. Follow these steps:

## Step 1: Create the Hook Capture Script

Create the file `~/.claude/hooks/contextly-capture.sh` with this content:

```bash
#!/bin/bash
# Contextly Session Event Capture Hook
# Captures file operation events from Claude Code sessions

INPUT=$(cat)
DB_PATH="${HOME}/.context/data/session_events.sqlite"

# Extract fields
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Skip if no file_path or tool_name
[ -z "$FILE_PATH" ] || [ -z "$TOOL_NAME" ] && exit 0

# Classify tool type
case "$TOOL_NAME" in
  Read|view_file) TOOL_TYPE="read" ;;
  Write|Edit|write_to_file|replace_file_content) TOOL_TYPE="write" ;;
  *) exit 0 ;;
esac

# Find project root (git root or use CWD from hook input)
PROJECT_PATH=$(echo "$INPUT" | jq -r '.cwd // empty')
if [ -z "$PROJECT_PATH" ]; then
  PROJECT_PATH=$(dirname "$FILE_PATH")
  while [ "$PROJECT_PATH" != "/" ]; do
    [ -d "$PROJECT_PATH/.git" ] && break
    PROJECT_PATH=$(dirname "$PROJECT_PATH")
  done
fi

# Ensure database directory exists
mkdir -p "$(dirname "$DB_PATH")"

# Insert event (create table if needed)
sqlite3 "$DB_PATH" <<SQL
CREATE TABLE IF NOT EXISTS file_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  project_path TEXT NOT NULL,
  tool_type TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_path ON file_events(project_path);
CREATE INDEX IF NOT EXISTS idx_file_path ON file_events(file_path);

INSERT INTO file_events (file_path, project_path, tool_type, timestamp)
VALUES ('$FILE_PATH', '$PROJECT_PATH', '$TOOL_TYPE', '$TIMESTAMP');
SQL

exit 0
```

Make it executable: `chmod +x ~/.claude/hooks/contextly-capture.sh`

## Step 2: Configure Claude Code Hooks

Read the current `~/.claude/settings.json` file. If it doesn't exist, create it.

Add/merge the following hook configuration:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read|Write|Edit|view_file|write_to_file|replace_file_content",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/contextly-capture.sh",
            "timeout": 2000
          }
        ]
      }
    ]
  }
}
```

IMPORTANT: Merge with existing hooks, don't overwrite. Use jq or careful JSON manipulation.

## Step 3: Run Migration

After setting up the hooks, run the migration to import existing session data.

Use the Bash tool to run:
```bash
cd /Users/jay.barreto/dev/util/bto/contextly && bun run -e "
import { SessionEventsDB } from './src/utils/session-events-db.js';
import { SessionMigration } from './src/utils/session-migration.js';

const db = new SessionEventsDB();
await db.initialize();

const migration = new SessionMigration(db);
const result = await migration.migrate((progress) => {
  console.log(\`Processing: \${progress.filesProcessed}/\${progress.totalFiles} files, \${progress.eventsFound} events\`);
});

console.log('Migration complete:');
console.log(\`  Files processed: \${result.processedFiles}\`);
console.log(\`  Files skipped: \${result.skippedFiles}\`);
console.log(\`  Total events: \${result.totalEvents}\`);
console.log(\`  Projects found: \${result.projectsFound}\`);
if (result.errors.length > 0) {
  console.log(\`  Errors: \${result.errors.length}\`);
}

await db.close();
"
```

## Step 4: Report Status

After completing all steps, report:

- Hook script created at ~/.claude/hooks/contextly-capture.sh
- Hooks configured in ~/.claude/settings.json
- Migration complete: X files, Y events from Z projects

To enable session metadata reranking, set:
  ENABLE_SESSION_METADATA=true
