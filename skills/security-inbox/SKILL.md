---
name: security-inbox
description: Record and revisit project issues through Security Inbox MCP, including functional bugs, UI problems, code quality and security observations found during another task. Use it as the inbox for deferred work; recording an issue does not authorize investigation or a fix.
---

# Security Inbox

Capture what was observed, keep enough context to resume later, and continue the current task.

- Identify the project with `list_projects` and its stored `directoryPath`; never choose by name alone or invent a `projectId`. The default list belongs to `SECURITY_INBOX_USER`. Use `scope: "all"` when the target project belongs to someone else.
- If the project is missing, use its known absolute `directoryPath` with `browse_project_directories` and `register_project`, or navigate using returned `relativePath` values. Native browsing starts in the personal folder and can move up; an explicitly configured root or Docker mount limits availability. Pass one path form per request. Ownership comes from the process configuration. If it returns `USER_REQUIRED`, request the missing user configuration rather than guessing a slug.
- When a concrete issue appears outside the current task, search the project with `list_findings.query`, using a distinctive title or known file path. Read likely matches and add context to an existing issue when appropriate. Keep this check brief; do not expand the investigation just to fill the inbox.
- Register a new observation with `projectId`, a stable `idempotencyKey`, `title` and a short `description` explaining what happened and how to find it again. Include known file, line and commit information. Evidence, severity, origin and recommendation are optional; leave severity unclassified when uncertain and do not invent evidence. Reuse the same key and payload for a retry.
- After recording it, continue the original task. Reporting an unrelated issue does not authorize fixing it, scanning the rest of the project or changing the user's priorities.
- When asked to revisit pending work, collect the relevant list first. Follow `nextOffset` with the same filters until it is `null`; each page has at most 100 entries. Collect pages before editing or changing statuses, because updates can reorder the list. Then use `get_finding` with both `projectId` and `findingId` for the complete context and history.
- Within the requested review or fix, enrich the facts with `update_finding`, append progress with `add_finding_note` and use `update_finding_status` for lifecycle changes. Set `in_progress` when starting the work. Confirm an observation only after checking it.
- Resolve or dismiss only after verifying the outcome. Include the reproduction, test or other check and any relevant commit in the required closing note; an intended fix or earlier note is insufficient.
- Event authors come from the configured user, independently of the optional free-text `origin`. Ownership and authorship are attribution, not access control or proof of permission. Respect the user's project scope; do not delete, merge or remedy issues beyond the requested work.
