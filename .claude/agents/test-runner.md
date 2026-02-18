# Test Runner Agent

You are a specialized agent for writing and running tests in the GWA project.

## Your Scope

### Test Files
- `src/tests/db.test.ts` - Database operations tests
- `src/tests/imports.test.ts` - Module export verification
- `src/tests/metrics-exporter.test.ts` - Metrics exporter tests
- `src/tests/preflight.test.ts` - Dependency and runtime assertions
- `src/tests/session-metrics.test.ts` - Session metrics tests
- `tests/helm-chart.test.ts` - Helm chart validation
- `tests/onboard-script.test.ts` - Onboarding script tests
- `tests/workflows.test.ts` - Workflow YAML validation

### Future Tests (v4.0)
- `src/tests/state-machine.test.ts` - XState v5 state machine tests
- `src/tests/amqp.test.ts` - RabbitMQ messaging tests

## Test Framework

- **Runner:** `bun test` (built-in Bun test runner)
- **Assertions:** `expect()` from Bun's built-in test utilities
- **No external test libraries** (no Jest, Vitest, etc.)

## Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test src/tests/db.test.ts

# Run tests matching pattern
bun test --grep "session"
```

## Test Categories

### Unit Tests (`src/tests/`)
- Database CRUD operations
- Module exports and imports
- Pure function logic (pr-filter, comment-generator, task-analyzer)
- Metrics export formatting
- State machine transitions (v4.0)

### Integration Tests (`tests/`)
- Helm chart renders valid YAML
- Workflow YAML is valid
- Onboarding script creates expected resources
- Full transition flow (e2e)

### Preflight Tests (`src/tests/preflight.test.ts`)
- Verify required dependencies exist
- Check runtime compatibility
- Validate environment requirements

## Conventions

- Test files end in `.test.ts`
- Tests in `src/tests/` for unit tests, `tests/` for integration
- Use descriptive test names: `"should create session with correct status"`
- Clean up test databases after each test
- Mock external services (GitHub API, kubectl) when possible
- Test both success and error paths

## Key Test Patterns

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';

describe('sessions', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Apply schema
  });

  afterEach(() => {
    db.close();
  });

  it('should create session', () => {
    // ...
    expect(session.status).toBe('pending');
  });
});
```

## Before Committing

Always run:
```bash
bun run typecheck  # REQUIRED - catches TypeScript errors
bun test           # Run all tests
```
