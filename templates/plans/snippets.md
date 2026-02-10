# Code Context: {{ISSUE_TITLE}}

**Issue:** #{{ISSUE_NUMBER}}
**Gathered During:** Planning Phase
**Purpose:** Provide workers with relevant code context without re-searching

---

## Key Files Overview

<!-- Summary of files relevant to this issue -->

| File | Purpose | Relevance to Issue |
|------|---------|-------------------|
| `{{FILE_PATH}}` | {{PURPOSE}} | {{WHY_RELEVANT}} |

---

## Code Snippets

### {{SNIPPET_1_TITLE}}

**File:** `{{FILE_PATH}}`
**Lines:** {{START_LINE}}-{{END_LINE}}
**Relevance:** {{WHY_THIS_MATTERS}}

```{{LANGUAGE}}
{{CODE_SNIPPET}}
```

**Notes:**
{{NOTES_ABOUT_THIS_CODE}}

---

### {{SNIPPET_2_TITLE}}

**File:** `{{FILE_PATH}}`
**Lines:** {{START_LINE}}-{{END_LINE}}
**Relevance:** {{WHY_THIS_MATTERS}}

```{{LANGUAGE}}
{{CODE_SNIPPET}}
```

**Notes:**
{{NOTES_ABOUT_THIS_CODE}}

---

### {{SNIPPET_3_TITLE}}

**File:** `{{FILE_PATH}}`
**Lines:** {{START_LINE}}-{{END_LINE}}
**Relevance:** {{WHY_THIS_MATTERS}}

```{{LANGUAGE}}
{{CODE_SNIPPET}}
```

**Notes:**
{{NOTES_ABOUT_THIS_CODE}}

---

<!-- Add more snippets as needed -->

---

## Interfaces & Types

<!-- Key type definitions workers need to implement against -->

### {{INTERFACE_NAME}}

**File:** `{{FILE_PATH}}`
**Used By:** {{WHICH_TASKS}}

```typescript
{{INTERFACE_DEFINITION}}
```

---

### {{TYPE_NAME}}

**File:** `{{FILE_PATH}}`
**Used By:** {{WHICH_TASKS}}

```typescript
{{TYPE_DEFINITION}}
```

---

## Existing Patterns to Follow

<!-- Examples of similar implementations in the codebase -->

### Pattern: {{PATTERN_NAME}}

**Example From:** `{{FILE_PATH}}`
**Apply To:** {{WHICH_TASKS}}

```{{LANGUAGE}}
{{PATTERN_EXAMPLE}}
```

**How to Apply:**
{{INSTRUCTIONS}}

---

### Pattern: {{PATTERN_NAME}}

**Example From:** `{{FILE_PATH}}`
**Apply To:** {{WHICH_TASKS}}

```{{LANGUAGE}}
{{PATTERN_EXAMPLE}}
```

**How to Apply:**
{{INSTRUCTIONS}}

---

## Database Schema Reference

<!-- Relevant tables and their structure -->

### Table: {{TABLE_NAME}}

**Used By:** {{WHICH_TASKS}}

```sql
{{TABLE_SCHEMA}}
```

**Key Columns:**
- `{{COLUMN}}` - {{DESCRIPTION}}
- `{{COLUMN}}` - {{DESCRIPTION}}

---

## API Endpoints Reference

<!-- Existing endpoints workers need to integrate with -->

### {{ENDPOINT_NAME}}

**Method:** {{HTTP_METHOD}}
**Path:** `{{PATH}}`
**Used By:** {{WHICH_TASKS}}

**Request:**
```json
{{REQUEST_EXAMPLE}}
```

**Response:**
```json
{{RESPONSE_EXAMPLE}}
```

---

## Configuration Reference

<!-- Config files and environment variables -->

### {{CONFIG_FILE}}

**Location:** `{{FILE_PATH}}`
**Relevant Sections:**

```{{FORMAT}}
{{CONFIG_SNIPPET}}
```

---

## Test Examples

<!-- Examples of how similar features are tested -->

### {{TEST_EXAMPLE_TITLE}}

**File:** `{{TEST_FILE}}`
**Pattern For:** {{WHICH_TASKS}}

```typescript
{{TEST_EXAMPLE}}
```

---

## External Dependencies

<!-- How to use packages relevant to this issue -->

### {{PACKAGE_NAME}}

**Import:** `{{IMPORT_STATEMENT}}`
**Used For:** {{PURPOSE}}

**Example Usage:**
```{{LANGUAGE}}
{{USAGE_EXAMPLE}}
```

**Docs:** {{DOCUMENTATION_URL}}

---

## Common Gotchas

<!-- Things that tripped up previous implementations -->

| Gotcha | Context | Solution |
|--------|---------|----------|
| {{GOTCHA_1}} | {{WHEN_IT_HAPPENS}} | {{HOW_TO_AVOID}} |
| {{GOTCHA_2}} | {{WHEN_IT_HAPPENS}} | {{HOW_TO_AVOID}} |

---

**Snippets Gathered:** {{COUNT}}
**Last Updated:** {{UPDATED_AT}}
