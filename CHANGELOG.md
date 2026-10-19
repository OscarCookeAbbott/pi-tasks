# Changelog

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
