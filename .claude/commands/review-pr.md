# /review-pr

Review a pull request: analyze changes, check for issues, suggest improvements.

## Usage

```
/review-pr <pr-number>
```

## Example

```
/review-pr 15
```

## What It Does

1. Fetches PR #15 diff and description
2. Analyzes code changes for:
   - Logic errors or bugs
   - Security vulnerabilities
   - Performance issues
   - Code style consistency
   - Missing tests
3. Posts review comments on specific lines
4. Provides overall summary

## Review Checklist

- [ ] Code follows project conventions
- [ ] No hardcoded secrets or credentials
- [ ] Error handling is appropriate
- [ ] Tests cover new functionality
- [ ] No unnecessary dependencies added
- [ ] Documentation updated if needed

## Notes

- Reviews are constructive, not nitpicky
- Suggests specific improvements, not vague feedback
- Approves if changes are good, requests changes if not
