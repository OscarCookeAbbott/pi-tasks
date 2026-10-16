# Pi Tasks

A Pi extension for forward-only, session-scoped task trees. It adds the `tasks` agent tool, a `/tasks` browser, a progress widget, and reminders that keep the active task in context.

## Install

Requires Node 22.19 or newer and Pi. Tested against **Pi 1.2.0**; older Pi releases are not supported. Pi supplies the runtime libraries, so there is no separate build or dependency installation step.

```sh
pi install git:github.com/OscarCookeAbbott/pi-tasks
```

Start a new session or run `/reload`. For a pinned release, append `@v0.4.0` to the source. Unpinned installs follow the repository's default branch when running `pi update --extensions`.

Use `pi install --local <source>` for a project-scoped installation; Pi loads it after project trust is granted. To uninstall:

```sh
pi remove git:github.com/OscarCookeAbbott/pi-tasks
```

Do not also keep a copied version under `~/.pi/agent/extensions/`: it would register the same tool and command twice. This package is distributed through Git; it is not published to npm yet.

## User interface

- `/tasks`: browse the entire tree, including closed tasks. Use ↑/↓, Page Up/Down, and Escape.
- `/tasks hidden`: hide the persistent widget.
- `/tasks active`: show the active task and its ancestor context.
- `/tasks incomplete`: show active, future, and waiting tasks (default).
- `/tasks all`: show every task.
- `/tasks show ab`: inspect a task's status, parent, own-work outcome, and final outcome.

The widget shows at most eight task rows, centred near the active task. The full browser is available even when the widget is hidden. Headers show closed/total counts such as `Tasks · 3/4 complete`, without a redundant slash-command hint; completed and cancelled tasks both count as closed, including parent tasks. This is a task count, not a work estimate.

Rows use boxed IDs, not order numbers: `▶ [ab] Implement`. UI markers are `▶` active, `○` future, `…` waiting, `✓` completed, and `×` cancelled. Agent-facing lists use explicit status words instead: `active [ab] Implement`. Normal tool calls/results remain visible regardless of widget visibility.

## Agent tool

The `tasks` tool accepts:

| Action | Fields |
| --- | --- |
| `add` | `title`; optional `parent`, `before`, `after` |
| `list` | optional `visibility` (defaults to `all`; does not change the widget) |
| `edit` | `id`, `title` |
| `move` | `id`; `parent` and/or `before`/`after`; optional `ancestorOutcomes` |
| `complete` | active `id`, brief `outcome`; optional `ancestorOutcomes` |
| `cancel` | active/future `id`; optional `reason`, `ancestorOutcomes` |

Use the two-character IDs inside brackets, without brackets in tool arguments. IDs are immutable two-character base-62 short hashes with collision resolution. Closed IDs are never recycled within the current history; the finite namespace supports 3,844 tasks. They are not globally unique across sessions or alternative branches.

Additions default to root/end. Moves retain their parent when `parent` is omitted; `parent: null` moves to the root. Reparenting without a position appends under the new parent. Anchors must be siblings of the added/moved task; `after` means after the anchor's entire subtree. Specify at most one of `before` and `after`.

Only wholly future subtrees can move. New tasks and moved subtrees must remain after the active task. Once the tree is finished, new root tasks can be appended, not inserted into completed history. Missing parents, cycles, self-anchors, closed-parent destinations, reopening, and arbitrary activation/skipping are rejected.

### Parents and progression

Execution is depth-first, with at most one active task. A parent's own work is active before its children:

1. Add children to the active parent.
2. Complete the parent with its own-work outcome, or cancel it with a reason.
3. If children are unfinished, the parent becomes **waiting** with a pending completed/cancelled disposition. Its first unfinished descendant becomes active.
4. The last child becoming completed/cancelled automatically closes the waiting parent. Closure can cascade through multiple ancestors.

Cancelling a parent does **not** cancel its descendants. Cancelling a future parent makes it waiting without changing the current active task; its children remain scheduled. Waiting parents cannot be directly completed/cancelled or moved, but can receive additional children in the future portion.

Completion/cancellation advances automatically. A pending-completed parent can still complete when its children were cancelled; the summary must accurately describe the outcome. A pending-cancelled parent closes as cancelled and retains its cancellation reason.

When an operation closes pending-completed ancestors, supply their final summaries atomically:

```json
{
  "action": "complete",
  "id": "m2",
  "outcome": "Regression tests pass.",
  "ancestorOutcomes": {
    "k7": "Implemented the fix and verified the regression."
  }
}
```

Missing/blank summaries reject the entire operation without changing tasks. The error names the ID and title of every ancestor requiring a summary. Active-task reminders warn when completing/cancelling the active task would close ancestors. A parent's original own-work outcome remains available separately from its final summary.

## Reminders and persistence

Mutation acknowledgements retain task IDs and titles, e.g. `Task [ab] completed: Review feedback`, followed by a compact checkpoint: `Active task [cd]: Implement refinements`, its parent path, and any required `ancestorOutcomes`. Explicit positioning is a separate `Position: after sibling [xy]` or `before sibling` line; explicit parent changes use `Parent: [pq]` or `root`. Default placement is not narrated. Lists already show the active task and ancestry, so they append only required ancestor-summary IDs; a hidden list view still receives the full checkpoint. Outcomes are persisted and shown in expanded TUI results or `/tasks show <id>`, without echoing their text into model context.

Workflow instructions live in the tool's prompt guidelines rather than repeating in each checkpoint. Other completed **top-level** tool calls and actual user messages count toward a **30-event** cadence by default. Nested calls (tools invoked internally by another tool, such as reads inside a `codemode` script) do not count separately. Every successful task-tool call, including completion, resets the event counter. Quick task progress can therefore prevent the periodic threshold from being reached. Periodic reminders appear as visible custom messages at safe turn boundaries, using the same standard tool-output styling as async-job completions; initial/restored state and compaction force a refresh. No timers, forced continuation turns, transient context edits, or rewriting old checkpoints are used. Widget visibility never disables reminders. Making reminders visible does not add model text or start extra turns.

Configure the interval and initial visibility in `~/.pi/agent/settings.json` (or trusted project `.pi/settings.json`):

```json
{
  "tasks": {
    "reminderInterval": 30,
    "defaultVisibility": "incomplete"
  }
}
```

Merge this into the existing settings object, then run `/reload`. The extension reads Pi's merged settings at session start. The interval must be a positive safe integer. `defaultVisibility` accepts `hidden`, `active`, `incomplete`, or `all`; it applies only when the current branch has no saved task snapshot. Saved visibility is preserved. Invalid configuration warns and uses defaults: interval 30, initial visibility `incomplete`. Omitted fields use the same defaults. Task changes and restoration/compaction refreshes do not wait for the interval.

The cadence is in-memory and resets on session start/reload/resume. Reminders remain ordinary append-only history, preserving existing transcript prefixes; provider cache behaviour is still provider-dependent.

Versioned snapshots are stored as `tasks-state` custom session entries, excluded from model context. Reload, resume, fork, and `/tree` navigation restore from the current branch only. Compaction does not delete durable task state. Unreadable snapshots disable mutation rather than silently overwriting history. Session navigation can restore earlier progress; the forward-only rule applies inside a branch.

Tools work in non-interactive modes; the persistent widget/browser require TUI mode. Agent work matching the active task is guided by reminders, not enforced by blocking other tools.

## Development

From the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm pack --dry-run
```

Tests use the pinned local Pi development dependencies, not a global executable. After dependency installation, they need no model, network, credentials, or personal session files. CI runs on Node 22.19 and 24.

The suite covers atomic nested closure and summaries, cancellation, forward-only insertion and subtree reparenting, all ID collisions/exhaustion, branch restoration, visibility, narrow terminal rendering, reminder cadence, corrupt snapshots, and persistence rollback.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and release guidance, and [CHANGELOG.md](CHANGELOG.md) for releases.

## Licence

[MIT](LICENSE).
