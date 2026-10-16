# Changelog

## 0.4.2

- Highlight task IDs and titles in call headers; show add titles inline and shorten UI acknowledgements without removing titles from model feedback or placement details.
- Give reminder headings bold, high-contrast styling while preserving themed backgrounds and padding.

## 0.4.1

- Lead tool descriptions and prompt summaries with substantive work and outcome tracking, without requiring a pre-planned multi-step sequence.
- Use bold tool names, muted arguments, standard output/error colours and muted expanded metadata; avoid undefined arguments during streaming.
- Restore themed notification backgrounds for task reminders and respect output padding.

## 0.4.0

- Keep task titles in compact acknowledgements, qualify explicit sibling/parent placement, and avoid repeating list checkpoints or supplied outcomes.
- Preserve outcomes and affected-task details in expanded TUI results; use concise `Tasks · 3/4 complete` headings without redundant slash-command hints.
- Show reminders as visible, styled custom messages without adding model text or continuation turns. Successful task calls, including completion, reset the event counter.
- Render actual refusal text when Pi supplies empty error details instead of displaying undefined output.

## 0.3.0

- Task IDs use the full two-character base-62 alphabet, raising the namespace from 1,296 to 3,844 IDs. Existing lowercase base-36 IDs remain valid.

## 0.2.0

- Boxed IDs and closed/total counts replace row order numbers and redundant UI labels.
- Agent-facing lists use explicit statuses; checkpoints retain only active work, ancestry, and required closure summaries.
- Missing-summary errors include parent titles; `tasks.defaultVisibility` sets initial visibility without overriding saved state.

## 0.1.0

- Initial standalone Git release of the `tasks` tool and `/tasks` interface.
- Forward-only task trees, immutable short IDs, atomic parent closure, and session-branch persistence.
- Configurable model reminders and user-controlled progress widgets.
