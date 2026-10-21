# Changelog

## 0.12.2

- Open `/tasks` as an exactly sized full-terminal overlay, hiding duplicate persistent headers while leaving widgets live underneath and restoring them on close.

## 0.12.1

- Restore compact status-marker/ID/title rows for tasks and notes in widgets, browsers, tool lists and native overview contributions.
- Restore space-separated tool call headers and structured inspection/comparison layouts; keep label-first punctuation only on existing sentence-style messages.

## 0.12.0

- Put labels before ID/title pairs across mutation feedback, active checkpoints/reminders, trees, note previews, inspection and overview contributions (e.g. `Task added: [ab] Build`). Keep ID-only acknowledgements and raw note content unchanged.
- Use concise blue mutation acknowledgements and bounded description/outcome previews without exposing workflow checkpoints in the TUI.
- Move note bodies/retraction reasons out of headers into expandable result previews; retain compact agent mutations and ID-only note listings.
- Preview note listings for users and keep full note history available on expansion/inspection.

## 0.11.0

- Group owned Subtasks and Notes explicitly in overview task menus, with typed native presentation, readable status/count subtitles and focused content-card bodies.
- Keep full metadata available for copying while giving notes their own text/retraction context rather than a mixed task-detail wall.

## 0.10.0

- Publish complete task metadata and recursive task/note ownership to the overview menu, without item truncation.
- Give notes independent selectable/expandable nodes in `/tasks`, rather than inlining their bodies in task details.
- Show every filtered widget row when it fits; omit the overflow range unless rows are genuinely clipped.

## 0.9.0

- Add selectable `/tasks` full views with Enter/Space detail expansion, paging, navigation buttons and fullscreen mouse support.
- Move compact overflow counts beside header progress; avoid dumping the full tree and unrelated notes in expanded mutation results.
- Publish optional per-instance overview progress, task states and visible notes through a load-order-independent event protocol, without a dependency.
- Default task/note notification events to all; invalid configuration still disables them safely.

## 0.8.0

- Include original note text in recording and retraction desktop notifications, using the notifier's existing sanitisation and preview limits without changing agent-facing tool feedback.

## 0.7.0

- Add opt-in desktop notifications for all task/note mutations and saved visibility changes, with `tasks.notifications` modes none (default), tasks, notes and all.
- Declare pi-notifications as an optional Git dependency and emit through `notifications:notify`; absent or failed notification consumers never change task results.

## 0.6.1

- Standardize displayed task IDs as [ab] and note IDs as <ab> through shared helpers across headers, acknowledgements, errors, lists, reminders and inspection.
- Keep tool arguments, stored IDs and task_notes list JSON arrays bare; show parent task IDs consistently in task inspection.

## 0.6.0

- Add optional backward-compatible task descriptions, editable independently while open and clearable with an empty string.
- Show aligned title/description before-and-after values in expanded task edit results without adding them to model feedback.
- Add task_notes list(taskId), returning only note IDs in creation order, including retracted records.
- Make bare /tasks a complete unfiltered, wrapped inspection of tasks, descriptions, outcomes and all note history; widget filters remain independent.
- Use compact ◆ <id> / ⊘ <id> note rows, bold-accented primary arguments and readable actions.
- Label periodic/restored/compaction messages as Active task reminder to distinguish them from actual task-operation checkpoints.

## 0.5.0

- Add task_notes record/retract/read for important decisions, discoveries, constraints and risks; completion outcomes remain separate.
- Permanently bind immutable timestamped notes to their active task, with an independent base-62 ID pool and irreversible, reasoned retraction.
- Add saved /tasks notes all|active|none visibility, defaulting to unretracted notes and subordinate to task filtering. Inspection and model-facing lists retain full note history.
- Migrate v1 snapshots to v2 without losing tasks and keep historical tool results expandable; preserve notes across branch navigation and reject corrupt snapshots or failed persistence without overwriting state.
- Keep note rows single-line and with their visible owner in the clipped widget; display full note text safely on explicit read.

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
