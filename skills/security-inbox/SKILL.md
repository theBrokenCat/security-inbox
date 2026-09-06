---
name: security-inbox
description: Use the Security Inbox MCP tools to search, record, review, and update project-scoped security findings. Do not use this skill to perform the security analysis or remediation itself.
---

# Security Inbox

Use Security Inbox only as the finding inbox; it does not confirm or fix vulnerabilities.

1. Start with `list_projects`; match the stored `directoryPath` and never guess `projectId`.
2. If the directory is not registered, use `browse_project_directories` from the configured root and pass its exact `relativePath` to `register_project`. Do not invent or escape the allowed path.
3. Search that project with `list_findings.query` before registering anything. Review likely matches instead of silently duplicating them.
4. For `register_finding`, provide a stable idempotency key, title, description, severity, concrete evidence, origin, and any known location, commit, or recommendation. Keep every finding identity scoped by both `projectId` and `findingId`.
5. Use `update_finding` for factual edits, `add_finding_note` for context, and `update_finding_status` for lifecycle changes. Treat a new finding as a suspicion and confirm it only when evidence supports that conclusion.
6. Before `resolved` or `dismissed`, verify the claimed outcome and include that check in the required transition note. Never resolve based only on a prior note or an intended fix.
7. Respect the user's project scope and correction order. Do not expand the investigation, merge findings, delete data, or perform remediation unless separately requested.
