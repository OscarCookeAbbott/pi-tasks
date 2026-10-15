import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readReminderInterval, ReminderCadence } from "./reminders.ts";
import { activeTask, emptyState, reminder, restoreState, transition, treeLines, type Action, type TaskState, type Visibility } from "./state.ts";

const id = Type.String({ pattern: "^[0-9a-z]{2}$", description: "Immutable two-character task ID" });
const parent = Type.Optional(Type.Union([id, Type.Null()], { description: "Existing parent ID; null means root" }));
const position = { before: Type.Optional(id), after: Type.Optional(id) };
const ancestorOutcomes = Type.Optional(Type.Record(id, Type.String({ minLength: 1 }), { description: "Final summaries for waiting ancestors completed by this operation" }));
const visibility = Type.Union([Type.Literal("hidden"), Type.Literal("active"), Type.Literal("incomplete"), Type.Literal("all")]);
// Providers expect a top-level object; the state machine validates action-specific requirements.
const parameters = Type.Object({
  action: Type.Union((["add", "move", "edit", "complete", "cancel", "list"] as const).map((value) => Type.Literal(value))),
  id: Type.Optional(id),
  title: Type.Optional(Type.String({ minLength: 1, description: "Required for add/edit" })),
  parent,
  ...position,
  outcome: Type.Optional(Type.String({ minLength: 1, description: "Required for complete: brief outcome summary" })),
  reason: Type.Optional(Type.String()),
  ancestorOutcomes,
  visibility: Type.Optional(visibility),
}, { additionalProperties: false });

const markers = { "▶": "accent", "✓": "success", "×": "dim", "…": "warning", "○": "muted" } as const;
const message = (state: TaskState) => ({ customType: "tasks-reminder", content: reminder(state), display: false });

export default function tasksExtension(pi: ExtensionAPI): void {
  let state = emptyState();
  let restoreError: string | undefined;
  let skipStartingUser = false;
  let cadence = new ReminderCadence();

  function persist(): void {
    pi.appendEntry("tasks-state", structuredClone(state));
  }

  function updateWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    if (state.visibility === "hidden" || !state.tasks.length || restoreError) {
      ctx.ui.setWidget("tasks", undefined);
      return;
    }
    ctx.ui.setWidget("tasks", (_tui, theme) => ({
      render(width: number): string[] {
        const lines = treeLines(state);
        if (!lines.length) return [truncateToWidth(theme.fg("muted", "Tasks · no active task"), width)];
        const activeIndex = lines.findIndex((line) => line.trimStart().startsWith("▶"));
        const start = Math.max(0, activeIndex - 2);
        const shown = lines.slice(start, start + 8);
        return [
          truncateToWidth(theme.fg("muted", `Tasks · ${state.visibility} · /tasks to browse`), width),
          ...shown.map((line) => truncateToWidth(theme.fg(markers[line.trimStart()[0] as keyof typeof markers] ?? "muted", line), width)),
          ...(start > 0 || start + shown.length < lines.length ? [truncateToWidth(theme.fg("dim", `Showing ${start + 1}–${start + shown.length} of ${lines.length}`), width)] : []),
        ];
      },
      invalidate() {},
    }));
  }

  function restore(ctx: ExtensionContext): void {
    try {
      state = restoreState(ctx.sessionManager.getBranch());
      restoreError = undefined;
    } catch (error) {
      // Never replace an unreadable durable snapshot with an empty one.
      restoreError = error instanceof Error ? error.message : String(error);
      state = emptyState();
      ctx.ui.notify(`Tasks restoration failed: ${restoreError}`, "error");
    }
    cadence.force();
    skipStartingUser = false;
    updateWidget(ctx);
  }

  pi.on("session_start", (_event, ctx) => {
    try {
      cadence = new ReminderCadence(readReminderInterval(pi.getSettings()));
    } catch (error) {
      cadence = new ReminderCadence();
      ctx.ui.notify(`Tasks reminder config: ${error instanceof Error ? error.message : String(error)} Using the default interval of 30.`, "warning");
    }
    restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_compact", () => cadence.force());

  pi.on("before_agent_start", (event) => {
    skipStartingUser = event.messageType === "user";
    if (!activeTask(state) || restoreError) return;
    if (skipStartingUser) cadence.tick();
    if (cadence.take()) return { message: message(state) };
  });
  pi.on("message_end", (event) => {
    if (event.message.role !== "user") return;
    if (skipStartingUser) {
      skipStartingUser = false;
      return;
    }
    if (activeTask(state) && !restoreError) cadence.tick();
  });
  pi.on("tool_result", (event) => {
    // Task results already carry a checkpoint; nested calls belong to the outer tool decision.
    if (!event.parentToolCallId && event.toolName !== "tasks" && activeTask(state) && !restoreError) cadence.tick();
  });
  pi.on("turn_end", (event) => {
    if (!activeTask(state) || restoreError || !cadence.take()) return;
    return { entries: [...event.entries, { type: "custom_message" as const, ...message(state) }] };
  });

  pi.registerTool({
    name: "tasks",
    label: "Tasks",
    description: "Manage a forward-only task tree. Add, list, edit, move future subtrees (position and/or parent), complete the active task with an outcome, or cancel active/future tasks. Completing/cancelling a parent with unfinished children makes it waiting and advances into its children. Final child closure automatically closes waiting ancestors; include ancestorOutcomes for each completing ancestor. Cancelled parents do not cancel their children. IDs never change. Anchors must be siblings; additions default to root/end, moves retain their parent unless specified. Only the future portion can be reordered.",
    promptSnippet: "Track ordered tasks and parent/child progress with immutable short IDs.",
    promptGuidelines: ["Use tasks for multi-step work. Work on only the active task; complete it with a brief outcome or cancel it before advancing. Supply ancestorOutcomes when the final child closes a waiting parent."],
    parameters,
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      if (restoreError) throw new Error(`Tasks state is unavailable: ${restoreError}`);
      const previous = state;
      let response: string;
      if (params.action === "list") {
        response = treeLines(state, params.visibility ?? "all").join("\n") || "No tasks in this view.";
      } else {
        state = transition(state, params as Action);
        try {
          persist();
        } catch (error) {
          state = previous;
          throw error;
        }
        const changed = params.action === "add" ? state.tasks.find((task) => !previous.tasks.some((old) => old.id === task.id))! : state.tasks.find((task) => task.id === params.id)!;
        response = `${changed.id}: ${changed.title} — ${changed.status}${changed.status === "waiting" ? ` (pending ${changed.disposition}; children remain scheduled)` : ""}${changed.outcome ? `\nOutcome: ${changed.outcome}` : ""}`;
        const closed = state.tasks.filter((task) => task.id !== changed.id && previous.tasks.find((old) => old.id === task.id)?.status === "waiting" && (task.status === "completed" || task.status === "cancelled"));
        for (const task of closed) response += `\n${task.id}: ${task.status} — ${task.outcome}`;
        updateWidget(ctx);
      }
      cadence.reset();
      return {
        content: [{ type: "text", text: `${response}\n${reminder(state)}` }],
        details: { response, state: structuredClone(state) },
      };
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", `tasks ${args.action}`) + (args.id ? ` ${args.id}` : ""), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as { response: string; state: TaskState } | undefined;
      if (!details) return new Text(result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n"), 0, 0);
      const text = expanded ? `${details.response}\n${treeLines(details.state, "all").join("\n")}` : details.response;
      return new Text(theme.fg("muted", text), 0, 0);
    },
  });

  pi.registerCommand("tasks", {
    description: "Browse tasks, set hidden/active/incomplete/all visibility, or show <id> details",
    getArgumentCompletions(prefix) {
      return ["hidden", "active", "incomplete", "all", "show "].flatMap((value) => value.startsWith(prefix) ? [{ value, label: value }] : []);
    },
    async handler(args, ctx) {
      if (restoreError) {
        ctx.ui.notify(`Tasks state is unavailable: ${restoreError}`, "error");
        return;
      }
      const value = args.trim();
      if (["hidden", "active", "incomplete", "all"].includes(value)) {
        const previous = state;
        state = { ...state, visibility: value as Visibility };
        try { persist(); } catch (error) { state = previous; throw error; }
        updateWidget(ctx);
        return;
      }
      if (value.startsWith("show ")) {
        const task = state.tasks.find((task) => task.id === value.slice(5).trim());
        if (!task) {
          ctx.ui.notify("Unknown task ID.", "error");
          return;
        }
        ctx.ui.notify(`${task.id}: ${task.title}\nStatus: ${task.status}\nParent: ${task.parent ?? "root"}${task.ownOutcome ? `\nOwn work: ${task.ownOutcome}` : ""}${task.outcome ? `\nOutcome: ${task.outcome}` : ""}`, "info");
        return;
      }
      if (value) {
        ctx.ui.notify("Usage: /tasks [hidden|active|incomplete|all|show <id>]", "error");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(treeLines(state, "all").join("\n") || "No tasks.", "info");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        let offset = 0;
        return {
          render(width) {
            const lines = treeLines(state, "all");
            const height = Math.max(1, tui.terminal.rows - 6);
            offset = Math.min(offset, Math.max(0, lines.length - height));
            return [theme.fg("accent", "Tasks · ↑↓ / PgUp PgDn · Esc to close"), ...((lines.length ? lines : ["No tasks."]).slice(offset, offset + height).map((line) => truncateToWidth(line, width)))].map((line) => truncateToWidth(line, width));
          },
          handleInput(data) {
            if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return done();
            const page = Math.max(1, tui.terminal.rows - 6);
            if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
            if (matchesKey(data, "down")) offset++;
            if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - page);
            if (matchesKey(data, "pageDown")) offset += page;
            tui.requestRender();
          },
          invalidate() {},
        };
      });
    },
  });
}
