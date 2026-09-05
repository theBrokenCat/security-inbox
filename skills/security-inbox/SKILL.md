---
name: security-inbox
description: Use the Security Inbox MCP tools to search, record, review, and update project-scoped security findings. Do not use this skill to perform the security analysis or remediation itself.
---

# Security Inbox

Use Security Inbox only as the finding inbox; it does not confirm or fix vulnerabilities.

1. Identify the target with `list_projects`; never guess `projectId`.
2. Search that project with `list_findings.query` before registering anything. Review likely matches instead of silently duplicating them.
3. For `register_finding`, provide a stable idempotency key, title, description, severity, concrete evidence, origin, and any known location, commit, or recommendation. Keep every finding identity scoped by both `projectId` and `findingId`.
4. Treat a new or `pending_review` finding as a suspicion. Mark it `confirmed` only when evidence supports that conclusion.
5. Before `resolved` or `dismissed`, verify the claimed outcome and include that check in the required transition note. Never resolve based only on a prior note or an intended fix.
6. Respect the user's project scope and correction order. Record context with `add_finding_note`; do not expand the investigation, merge findings, or perform remediation unless separately requested.
