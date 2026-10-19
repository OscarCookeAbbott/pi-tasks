import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { createBrowser } from "./browser.ts";
import { Type } from "typebox";
import { readReminderInterval, ReminderCadence } from "./reminders.ts";
import { noteId, taskId } from "./ids.ts";
import { activeTask, closingParents, describeNote, emptyState, findNote, reminder, restoreState, terminal, transition, transitionNote, treeLines, type Action, type NoteAction, type NoteVisibility, type Task, type TaskNote, type TaskState, type Visibility } from "./state.ts";

const id = Type.String({ pattern: "^[0-9a-zA-Z]{2}$", description: "Immutable two-character task ID" });
const parent = Type.Optional(Type.Union([id, Type.Null()], { description: "Existing parent ID; null means root" }));
const position = { before: Type.Optional(id), after: Type.Optional(id) };
const ancestorOutcomes = Type.Optional(Type.Record(id, Type.String({ minLength: 1 }), { description: "Final summaries for waiting ancestors completed by this operation" }));
const visibility = Type.Union([Type.Literal("hidden"), Type.Literal("active"), Type.Literal("incomplete"), Type.Literal("all")]);
// Providers expect a top-level object; the state machine validates action-specific requirements.
const parameters = Type.Object({
  action: Type.Union((["add", "move", "edit", "complete", "cancel", "list"] as const).map((value) => Type.Literal(value))),
  id: Type.Optional(id),
  title: Type.Optional(Type.String({ minLength: 1, description: "Required for add; optional for edit" })),
  description: Type.Optional(Type.String({ description: "Optional task context for add/edit; empty clears. Editable while open." })),
  parent,
  ...position,
  outcome: Type.Optional(Type.String({ minLength: 1, description: "Required for complete: brief outcome summary" })),
  reason: Type.Optional(Type.String()),
  ancestorOutcomes,
  visibility: Type.Optional(visibility),
}, { additionalProperties: false });

type NotificationMode = "none" | "tasks" | "notes" | "all";

const markers = { "▶": "accent", "✓": "success", "×": "dim", "…": "warning", "○": "muted", "◆": "toolOutput", "⊘": "dim" } as const;
const message = (state: TaskState) => ({ customType: "tasks-reminder", content: reminder(state).replace(/^Active task /, "Active task reminder "), display: true });
const progress = (state: TaskState) => `${state.tasks.filter(terminal).length}/${state.tasks.length}`;
const plainText = (text: string): string => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

function compareValues(label: string, before: string, after: string): string[] {
  return [["before:", before], ["after:", after]].map(([kind, text]) => {
    const prefix = `${label} ${kind.padEnd(7)} `;
    return prefix + text.replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
  });
}

export default function tasksExtension(pi: ExtensionAPI): void {
  let defaultVisibility: Visibility = "incomplete";
  let defaultNoteVisibility: NoteVisibility = "active";
  let state = emptyState(defaultVisibility, defaultNoteVisibility);
  let restoreError: string | undefined;
  let skipStartingUser = false;
  let cadence = new ReminderCadence();
  let notificationMode: NotificationMode = "all";
  let removeOverviewHook: (() => void) | undefined;

  pi.registerMessageRenderer("tasks-reminder", (message, { outputPad }, theme) => {
    const text = typeof message.content === "string" ? message.content : message.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
    const box = new Box(outputPad ?? 1, 1, (line) => theme.bg("customMessageBg", line));
    const [heading, ...body] = text.split("\n");
    box.addChild(new Text(theme.fg("toolTitle", theme.bold(heading!)) + (body.length ? `\n${theme.fg("customMessageText", body.join("\n"))}` : ""), 0, 0));
    return box;
  });

  function persist(): void {
    pi.appendEntry("tasks-state", structuredClone(state));
  }

  function notifyChange(event: string, message: string): void {
    const category = event.startsWith("task_notes.") ? "notes" : "tasks";
    if (notificationMode !== "all" && notificationMode !== category) return;
    try {
      pi.events.emit("notifications:notify", { event, title: "Pi Tasks", message });
    } catch {
      // Optional notification consumers must not affect persisted task changes.
    }
  }

  function publishOverview(): void {
    try {
      if (restoreError || !state.tasks.length) { pi.events.emit("overview:remove", "tasks"); return; }
      const statuses = { active: "running", future: "pending", waiting: "waiting", completed: "complete", cancelled: "cancelled" };
      const sections = [{ title: "Tasks", items: state.tasks.map((task) => ({
        title: `${taskId(task.id)} ${task.title}`, state: statuses[task.status], detail: task.description || task.outcome || "",
      })) }];
      const notes = state.noteVisibility === "none" ? [] : state.notes.filter((note) => state.noteVisibility === "all" || note.retractedAt === undefined);
      if (notes.length) sections.push({ title: "Notes", items: notes.map((note) => ({
        title: `${noteId(note.id)} ${note.text}`, state: note.retractedAt === undefined ? "unknown" : "cancelled", detail: `Task ${taskId(note.taskId)}${note.reason ? ` · ${note.reason}` : ""}`,
      })) });
      pi.events.emit("overview:publish", { id: "tasks", badge: `${progress(state)} tasks`, sections });
    } catch { /* Overview is optional and must not affect tasks. */ }
  }
  function subscribeOverview(): void {
    if (!removeOverviewHook) removeOverviewHook = pi.events.on("overview:collect", publishOverview);
  }
  subscribeOverview();

  function updateWidget(ctx: ExtensionContext): void {
    publishOverview();
    if (ctx.mode !== "tui") return;
    if (state.visibility === "hidden" || !state.tasks.length || restoreError) {
      ctx.ui.setWidget("tasks", undefined);
      return;
    }
    ctx.ui.setWidget("tasks", (_tui, theme) => ({
      render(width: number): string[] {
        const lines = treeLines(state);
        const heading = `Tasks · ${progress(state)} complete`;
        if (!lines.length) return [truncateToWidth(theme.fg("muted", heading), width)];
        const activeIndex = lines.findIndex((line) => line.trimStart().startsWith("▶"));
        let start = Math.max(0, activeIndex - 2);
        while (start > 0 && /^[◆⊘]/.test(lines[start]?.trimStart() ?? "")) start--;
        if (activeIndex - start >= 8) start = activeIndex;
        const shown = lines.slice(start, start + 8);
        return [
          truncateToWidth(theme.fg("muted", heading + (start > 0 || start + shown.length < lines.length ? ` · Showing ${start + 1}-${start + shown.length}/${lines.length}` : "")), width),
          ...shown.map((line) => truncateToWidth(theme.fg(markers[line.trimStart()[0] as keyof typeof markers] ?? "muted", line), width)),
        ];
      },
      invalidate() {},
    }));
  }

  function restore(ctx: ExtensionContext): void {
    try {
      state = restoreState(ctx.sessionManager.getBranch(), defaultVisibility, defaultNoteVisibility);
      restoreError = undefined;
    } catch (error) {
      // Never replace an unreadable durable snapshot with an empty one.
      restoreError = error instanceof Error ? error.message : String(error);
      state = emptyState(defaultVisibility, defaultNoteVisibility);
      ctx.ui.notify(`Tasks restoration failed: ${restoreError}`, "error");
    }
    cadence.force();
    skipStartingUser = false;
    updateWidget(ctx);
  }

  pi.on("session_start", (_event, ctx) => {
    subscribeOverview();
    try {
      const settings = pi.getSettings();
      const interval = readReminderInterval(settings);
      const configuredVisibility = (settings as { tasks?: { defaultVisibility?: unknown } }).tasks?.defaultVisibility;
      if (configuredVisibility !== undefined && !["hidden", "active", "incomplete", "all"].includes(configuredVisibility as string)) {
        throw new Error("tasks.defaultVisibility must be hidden, active, incomplete, or all.");
      }
      const configuredNotes = (settings as { tasks?: { defaultNoteVisibility?: unknown } }).tasks?.defaultNoteVisibility;
      if (configuredNotes !== undefined && !["all", "active", "none"].includes(configuredNotes as string)) throw new Error("tasks.defaultNoteVisibility must be all, active, or none.");
      const configuredNotifications = (settings as { tasks?: { notifications?: unknown } }).tasks?.notifications;
      if (configuredNotifications !== undefined && !["none", "tasks", "notes", "all"].includes(configuredNotifications as string)) throw new Error("tasks.notifications must be none, tasks, notes, or all.");
      notificationMode = (configuredNotifications ?? "all") as NotificationMode;
      defaultVisibility = (configuredVisibility ?? "incomplete") as Visibility;
      defaultNoteVisibility = (configuredNotes ?? "active") as NoteVisibility;
      cadence = new ReminderCadence(interval);
    } catch (error) {
      defaultVisibility = "incomplete";
      defaultNoteVisibility = "active";
      notificationMode = "none";
      cadence = new ReminderCadence();
      ctx.ui.notify(`Tasks config: ${error instanceof Error ? error.message : String(error)} Using the default interval of 30 and visibility incomplete; notes active; notifications none.`, "warning");
    }
    restore(ctx);
  });
  pi.on("session_shutdown", () => { removeOverviewHook?.(); removeOverviewHook = undefined; });
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
    if (!event.parentToolCallId && event.toolName !== "tasks" && event.toolName !== "task_notes" && activeTask(state) && !restoreError) cadence.tick();
  });
  pi.on("turn_end", (event) => {
    if (!activeTask(state) || restoreError || !cadence.take()) return;
    return { entries: [...event.entries, { type: "custom_message" as const, ...message(state) }] };
  });

  pi.registerTool({
    name: "tasks",
    label: "Tasks",
    description: "Plan and track substantive work, outcomes and notes with tasks. Manage a forward-only task tree. Add, list, edit, move future subtrees (position and/or parent), complete the active task with an outcome, or cancel active/future tasks. Completing/cancelling a parent with unfinished children makes it waiting and advances into its children. Final child closure automatically closes waiting ancestors; include ancestorOutcomes for each completing ancestor. Cancelled parents do not cancel their children. IDs never change. Anchors must be siblings; additions default to root/end, moves retain their parent unless specified. Only the future portion can be reordered.",
    promptSnippet: "Plan and track substantive work, outcomes and notes with tasks.",
    promptGuidelines: ["Plan and track substantive work, outcomes and notes with tasks. Work on only the active task; complete it with a brief outcome or cancel it before advancing. Supply ancestorOutcomes when the final child closes a waiting parent."],
    parameters,
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      if (restoreError) throw new Error(`Tasks state is unavailable: ${restoreError}`);
      const previous = state;
      let response: string;
      let displayResponse: string | undefined;
      let checkpoint: string;
      const affectedIds: string[] = [];
      if (params.action === "list") {
        response = treeLines(state, params.visibility ?? "all", "text").join("\n") || "No tasks in this view.";
        const active = activeTask(state);
        const closing = active ? closingParents(state, active.id) : [];
        checkpoint = params.visibility === "hidden" ? reminder(state) : closing.length ? `ancestorOutcomes: ${closing.map(taskId).join(", ")}` : "";
      } else {
        state = transition(state, params as Action);
        try {
          persist();
        } catch (error) {
          state = previous;
          throw error;
        }
        const changed = params.action === "add" ? state.tasks.find((task) => !previous.tasks.some((old) => old.id === task.id))! : state.tasks.find((task) => task.id === params.id)!;
        const verb = { add: "added", move: "moved", edit: "updated", complete: "completed", cancel: "cancelled" }[params.action];
        const status = changed.status === "waiting" ? `waiting (${changed.disposition === "completed" ? "completion" : "cancellation"} pending)` : verb;
        response = `Task ${taskId(changed.id)} ${status}: ${changed.title}`;
        affectedIds.push(changed.id);
        const placement: string[] = [];
        if (params.action === "add" || params.action === "move") {
          if (params.parent !== undefined) placement.push(`Parent: ${changed.parent === null ? "root" : taskId(changed.parent)}`);
          if (params.before !== undefined) placement.push(`Position: before sibling ${taskId(params.before)}`);
          if (params.after !== undefined) placement.push(`Position: after sibling ${taskId(params.after)}`);
        }
        if (placement.length) response += `\n${placement.join("\n")}`;
        if (params.action === "add") displayResponse = [`Task ${taskId(changed.id)} added.`, ...placement].join("\n");
        const closed = state.tasks.filter((task) => task.id !== changed.id && previous.tasks.find((old) => old.id === task.id)?.status === "waiting" && (task.status === "completed" || task.status === "cancelled"));
        for (const task of closed) {
          response += `\nTask ${taskId(task.id)} ${task.status}: ${task.title}`;
          affectedIds.push(task.id);
        }
        checkpoint = reminder(state);
        updateWidget(ctx);
        notifyChange(`tasks.${params.action}`, response);
      }
      cadence.reset();
      return {
        content: [{ type: "text", text: [response, checkpoint].filter(Boolean).join("\n") }],
        details: { response, displayResponse, state: structuredClone(state), affectedIds, before: params.action === "edit" ? structuredClone(previous.tasks.find((task) => task.id === params.id)) : undefined },
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("tasks")) + theme.fg(args.action ? "toolTitle" : "muted", ` ${args.action ?? "..."}`)
        + (args.id ? theme.fg("accent", theme.bold(` ${taskId(args.id)}`)) : "")
        + (args.title ? theme.fg("accent", theme.bold(` ${plainText(args.title)}`)) : ""),
        0, 0,
      );
    },
    renderResult(result, { expanded }, theme, context) {
      const color = context?.isError ? "error" : "toolOutput";
      const details = result.details as { response: string; displayResponse?: string; state: TaskState; affectedIds?: string[]; before?: Task } | undefined;
      if (typeof details?.response !== "string") return new Text(theme.fg(color, result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n")), 0, 0);
      const lines: string[] = [];
      const comparisons: string[] = [];
      if (expanded && details.before) {
        const after = details.state.tasks.find((task) => task.id === details.before!.id);
        if (after) {
          comparisons.push(...compareValues(`Task ${taskId(after.id)}`, details.before.title, after.title));
          if (details.before.description !== after.description) comparisons.push(...compareValues("Description", details.before.description || "(none)", after.description || "(none)"));
        }
      }
      if (expanded) {
        for (const task of details.state.tasks.filter((task) => details.affectedIds?.includes(task.id))) {
          if (task.id !== details.before?.id) lines.push(`${taskId(task.id)} ${task.title}`);
          if (task.description?.trim() && (!details.before || details.before.description === task.description)) lines.push(`${taskId(task.id)} Description: ${task.description}`);
          if (task.ownOutcome && task.ownOutcome !== task.outcome) lines.push(`${taskId(task.id)} Own work: ${task.ownOutcome}`);
          if (task.outcome) lines.push(`${taskId(task.id)} Outcome: ${task.outcome}`);
        }
      }
      return new Text(theme.fg(color, plainText(comparisons.length ? comparisons.join("\n") : (details.displayResponse ?? details.response))) + (lines.length ? `\n${theme.fg("muted", plainText(lines.join("\n")))}` : ""), 0, 0);
    },
  });

  pi.registerTool({
    name: "task_notes",
    label: "Task Notes",
    description: "Record, retract, list and read important task-bound notes: decisions, discoveries, constraints and risks. Recording permanently binds immutable text to the active task. Retract with a reason; read preserves the original text, owner and history. Note IDs have their own namespace.",
    promptSnippet: "Record, retract, list and read important task-bound notes.",
    promptGuidelines: ["Record important decisions, discoveries, constraints and risks with task_notes; use task completion for outcomes. Retract superseded notes rather than editing them; retracted notes are history, not current guidance."],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("record"), Type.Literal("retract"), Type.Literal("read"), Type.Literal("list")]),
      id: Type.Optional(Type.String({ pattern: "^[0-9a-zA-Z]{2}$", description: "Note ID; required for retract/read" })),
      taskId: Type.Optional(Type.String({ pattern: "^[0-9a-zA-Z]{2}$", description: "Task ID; required for list" })),
      text: Type.Optional(Type.String({ minLength: 1, description: "Important note text; required for record" })),
      reason: Type.Optional(Type.String({ minLength: 1, description: "Reason for withdrawal; required for retract" })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_callId, params, _signal, _onUpdate, ctx) {
      if (restoreError) throw new Error(`Tasks state is unavailable: ${restoreError}`);
      const fields = { record: ["action", "text"], retract: ["action", "id", "reason"], read: ["action", "id"], list: ["action", "taskId"] };
      if (Object.keys(params).some((key) => !fields[params.action].includes(key))) throw new Error(`Unexpected fields for note ${params.action}.`);
      if (params.action === "list") {
        if (!params.taskId) throw new Error("Task ID is required for listing notes.");
        if (!state.tasks.some((task) => task.id === params.taskId)) throw new Error(`Unknown task ${taskId(params.taskId)}.`);
        const ids = state.notes.filter((note) => note.taskId === params.taskId).map((note) => note.id);
        const response = JSON.stringify(ids);
        cadence.reset();
        return { content: [{ type: "text", text: response }], details: { response, taskId: params.taskId, ids } };
      }
      if (params.action !== "record" && !params.id) throw new Error("Note ID is required for retract/read.");
      let note: TaskNote;
      if (params.action === "read") note = findNote(state, params.id!);
      else {
        const previous = state;
        state = transitionNote(state, params as NoteAction);
        try { persist(); } catch (error) { state = previous; throw error; }
        note = params.action === "record" ? state.notes.at(-1)! : findNote(state, params.id!);
        updateWidget(ctx);
      }
      const response = params.action === "read" ? describeNote(state, note) : `Note ${noteId(note.id)} ${params.action === "record" ? "recorded" : "retracted"} for task ${taskId(note.taskId)}.`;
      if (params.action !== "read") notifyChange(`task_notes.${params.action}`, `${response}\n${note.text}`);
      cadence.reset();
      return { content: [{ type: "text", text: response }], details: { response, note: structuredClone(note) } };
    },
    renderCall(args, theme) {
      let reference = "";
      if (args.id) reference = noteId(args.id);
      else if (args.taskId) reference = taskId(args.taskId);
      return new Text(
        theme.fg("toolTitle", theme.bold("task_notes")) + theme.fg(args.action ? "toolTitle" : "muted", ` ${args.action ?? "..."}`)
        + (reference ? theme.fg("accent", theme.bold(` ${reference}`)) : "")
        + (args.text ? theme.fg("accent", theme.bold(` ${plainText(args.text)}`)) : "")
        + (args.reason ? theme.fg("accent", theme.bold(` — ${plainText(args.reason)}`)) : ""),
        0, 0,
      );
    },
    renderResult(result, _options, theme, context) {
      const text = result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
      return new Text(theme.fg(context?.isError ? "error" : "toolOutput", plainText(text)), 0, 0);
    },
  });

  function taskDetails(task: Task): string {
    const notes = state.notes.filter((note) => note.taskId === task.id).map((note) => plainText(describeNote(state, note)));
    return `${taskId(task.id)} ${task.title}\nStatus: ${task.status}\nParent: ${task.parent === null ? "root" : taskId(task.parent)}${task.description?.trim() ? `\nDescription:\n${plainText(task.description)}` : ""}${task.ownOutcome ? `\nOwn work: ${task.ownOutcome}` : ""}${task.outcome ? `\nOutcome: ${task.outcome}` : ""}${notes.length ? `\n\n${notes.join("\n\n")}` : ""}`;
  }

  pi.registerCommand("tasks", {
    description: "Browse tasks, set task visibility or notes all|active|none, or show <id> details",
    getArgumentCompletions(prefix) {
      return ["hidden", "active", "incomplete", "all", "show ", "notes all", "notes active", "notes none"].flatMap((value) => value.startsWith(prefix) ? [{ value, label: value }] : []);
    },
    async handler(args, ctx) {
      if (restoreError) {
        ctx.ui.notify(`Tasks state is unavailable: ${restoreError}`, "error");
        return;
      }
      const value = args.trim();
      if (value.startsWith("notes")) {
        if (!["notes all", "notes active", "notes none"].includes(value)) {
          ctx.ui.notify("Usage: /tasks notes all|active|none", "error");
          return;
        }
        const previous = state;
        state = { ...state, noteVisibility: value.slice(6) as NoteVisibility };
        try { persist(); } catch (error) { state = previous; throw error; }
        updateWidget(ctx);
        if (previous.noteVisibility !== state.noteVisibility) notifyChange("task_notes.visibility", `Note visibility: ${state.noteVisibility}`);
        return;
      }
      if (["hidden", "active", "incomplete", "all"].includes(value)) {
        const previous = state;
        state = { ...state, visibility: value as Visibility };
        try { persist(); } catch (error) { state = previous; throw error; }
        updateWidget(ctx);
        if (previous.visibility !== state.visibility) notifyChange("tasks.visibility", `Task visibility: ${state.visibility}`);
        return;
      }
      if (value.startsWith("show ")) {
        const task = state.tasks.find((task) => task.id === value.slice(5).trim());
        if (!task) {
          ctx.ui.notify("Unknown task ID.", "error");
          return;
        }
        ctx.ui.notify(taskDetails(task), "info");
        return;
      }
      if (value) {
        ctx.ui.notify("Usage: /tasks [hidden|active|incomplete|all|notes all|notes active|notes none|show <id>]", "error");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify(plainText(treeLines(state, "all", "full", "all").join("\n")) || "No tasks.", "info");
        return;
      }
      const titles = treeLines(state, "all", "display", "none");
      await ctx.ui.custom<void>((tui, theme, _keys, done) => createBrowser({
        title: `Tasks · ${progress(state)} complete`, theme, height: () => Math.max(1, tui.terminal.rows - 6),
        items: state.tasks.map((task, index) => ({ title: titles[index], detail: taskDetails(task) })),
        selected: state.tasks.findIndex((task) => task.status === "active"),
        requestRender: () => tui.requestRender(), done,
      }));
    },
  });
}
