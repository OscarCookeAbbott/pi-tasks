# Changelog

## 0.2.0

- Boxed IDs and closed/total counts replace row order numbers and redundant UI labels.
- Agent-facing lists use explicit statuses; checkpoints retain only active work, ancestry, and required closure summaries.
- Missing-summary errors include parent titles; `tasks.defaultVisibility` sets initial visibility without overriding saved state.

## 0.1.0

- Initial standalone Git release of the `tasks` tool and `/tasks` interface.
- Forward-only task trees, immutable short IDs, atomic parent closure, and session-branch persistence.
- Configurable model reminders and user-controlled progress widgets.
