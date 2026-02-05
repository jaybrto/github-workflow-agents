# /process-issue

Process a GitHub issue: analyze, implement, test, and create PR.

## Usage

```
/process-issue <issue-number>
```

## Example

```
/process-issue 42
```

## What It Does

1. Fetches issue #42 details from GitHub
2. Creates feature branch: `feature/issue-42-{description}`
3. Analyzes requirements and plans implementation
4. Implements the solution
5. Runs tests (`bun test`)
6. Commits changes with conventional commit message
7. Creates PR linking to issue

## Prerequisites

- Issue must exist in the repository
- Issue should have clear acceptance criteria
- You must have write access to create branches

## Notes

- If requirements are unclear, Claude will ask for clarification
- Large issues may be broken into subtasks
- Always runs tests before creating PR
