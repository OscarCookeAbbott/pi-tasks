import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import extension from "../src/index.ts";
import { activeTask, emptyState, transition, type TaskState } from "../src/state.ts";

type Entry = { type: string; customType?: string; data?: unknown };
type Details = { response: string; state: TaskState; affectedIds: string[] };

function harness(settings: unknown = {}) {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const entries: Entry[] = [];
  const notifications: string[] = [];
  const widgets = new Map<string, any>();
  const renderers = new Map<string, Function>();
  let tool: ToolDefinition<TSchema, Details>;
  let command: any;
  let failWrites = false;
  const ctx = {
    mode: "tui",
    sessionManager: { getBranch: () => entries },
    ui: {
      setWidget: (key: string, content: unknown) => widgets.set(key, content),
      notify: (text: string) => notifications.push(text),
      custom: async (factory: any) => {
        const view = factory({ terminal: { rows: 12 }, requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => {});
        assert.ok(view.render(12).every((line: string) => visibleWidth(line) <= 12));
        view.handleInput("\u001b");
      },
    },
  } as unknown as ExtensionContext;
  extension({
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerTool: (definition: ToolDefinition<TSchema, Details>) => { tool = definition; },
    registerCommand: (_name: string, definition: any) => { command = definition; },
    registerMessageRenderer: (name: string, renderer: Function) => renderers.set(name, renderer),
    getSettings: () => settings,
    appendEntry: (customType: string, data: unknown) => {
      if (failWrites) throw new Error("Disk unavailable");
      entries.push({ type: "custom", customType, data });
    },
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  return {
    entries, notifications, widgets, renderers, ctx, emit,
    get tool() { return tool!; },
    get command() { return command; },
    widgetLines(width = 80): string[] {
      const factory = widgets.get("tasks");
      return factory ? factory({}, { fg: (_color: string, text: string) => text }).render(width) : [];
    },
    failWrites() { failWrites = true; },
    async call(params: JsonObject) {
      const validated = validateToolArguments(tool!, { type: "toolCall", id: "call", name: "tasks", arguments: params });
      const result = await tool!.execute("call", validated, undefined, undefined, ctx as any);
      emit("tool_result", { toolName: "tasks" });
      return result;
    },
  };
}

test("extension persists mutations, restores only the current branch, and keeps visibility user-only", async () => {
  const h = harness();
  h.emit("session_start");
  assert.equal(h.tool.executionMode, "sequential");
  assert.equal(Reflect.get(h.tool.parameters, "type"), "object");
  await assert.rejects(h.call({ action: "add" }), /Title/);
  await assert.rejects(h.call({ action: "complete", id: "invalid" }), /validation/i);
  const first = await h.call({ action: "add", title: "First" });
  const firstState = first.details!.state;
  const firstId = activeTask(firstState)!.id;
  await h.call({ action: "add", title: "Second" });
  assert.equal(h.entries.length, 2);
  await assert.rejects(h.call({ action: "complete", id: firstId, outcome: " " }), /empty/);
  assert.equal(h.entries.length, 2);
  await h.command.handler("hidden", h.ctx);
  assert.equal(h.widgets.get("tasks"), undefined);
  const listed = await h.call({ action: "list" });
  assert.match(listed.content[0].type === "text" ? listed.content[0].text : "", /active/);
  assert.equal(listed.details!.state.visibility, "hidden");

  h.entries.splice(1); // A tree navigation to the first task snapshot.
  h.emit("session_tree");
  const restored = await h.call({ action: "list" });
  assert.deepEqual(restored.details!.state, firstState);
  assert.equal(first.details!.state.tasks.length, 1); // Old tool-result snapshots stay immutable.
  await h.command.handler("", h.ctx); // Full-tree renderer also works at narrow widths.
});

test("tool schema and results support atomic parent closure and immediate active-task checkpoints", async () => {
  const h = harness();
  const added = await h.call({ action: "add", title: "Parent" });
  const parent = activeTask(added.details!.state)!.id;
  const childResult = await h.call({ action: "add", title: "Child", parent });
  const child = childResult.details!.state.tasks[1].id;
  const waiting = await h.call({ action: "complete", id: parent, outcome: "Own work done." });
  assert.equal(waiting.details!.response, `Task [${parent}] waiting (completion pending): Parent`);
  assert.match(waiting.content[0].type === "text" ? waiting.content[0].text : "", /ancestorOutcomes/);
  const count = h.entries.length;
  await assert.rejects(h.call({ action: "complete", id: child, outcome: "Child done." }), (error: unknown) => error instanceof Error && error.message.includes(`[${parent}] Parent`));
  assert.equal(h.entries.length, count);
  const closed = await h.call({ action: "complete", id: child, outcome: "Child done.", ancestorOutcomes: { [parent]: "Everything done." } });
  assert.equal(activeTask(closed.details!.state), undefined);
  assert.equal(closed.details!.response, `Task [${child}] completed: Child\nTask [${parent}] completed: Parent`);
  assert.doesNotMatch(closed.content[0].type === "text" ? closed.content[0].text : "", /Child done|Everything done/);
  assert.equal(closed.details!.state.tasks.find((task) => task.id === parent)!.outcome, "Everything done.");
  const render = h.tool.renderResult! as Function;
  const expanded = render(closed, { expanded: true }, { fg: (_color: string, text: string) => text }, {}).render(200).join("\n");
  assert.match(expanded, /Everything done/);
  assert.match(expanded, /Own work done/);
});

test("UI uses boxed IDs and closed/total counts while agent output uses explicit states", async () => {
  const h = harness();
  for (const title of ["First", "Second", "Third", "Fourth"]) await h.call({ action: "add", title });
  const listed = await h.call({ action: "list" });
  const [a, b, c, d] = listed.details!.state.tasks.map((task) => task.id);
  assert.equal(listed.details!.response, `active [${a}] First\nfuture [${b}] Second\nfuture [${c}] Third\nfuture [${d}] Fourth`);
  assert.doesNotMatch(listed.content[0].type === "text" ? listed.content[0].text : "", /[▶○…✓×]/);
  assert.equal(h.widgetLines()[0], "Tasks · 0/4 complete");
  const completed = await h.call({ action: "complete", id: a, outcome: "Done." });
  assert.equal(completed.details!.response, `Task [${a}] completed: First`);
  assert.equal(completed.content[0].type === "text" ? completed.content[0].text : "", `Task [${a}] completed: First\nActive task [${b}]: Second`);
  await h.call({ action: "cancel", id: b });
  await h.call({ action: "complete", id: c, outcome: "Done." });
  assert.deepEqual(h.widgetLines(), ["Tasks · 3/4 complete", `▶ [${d}] Fourth`]);
  for (const width of [1, 12, 80]) assert.ok(h.widgetLines(width).every((line) => visibleWidth(line) <= width));
  await h.call({ action: "cancel", id: d });
  assert.deepEqual(h.widgetLines(), ["Tasks · 4/4 complete"]);
});

test("Pi error results with empty details render the actual refusal", () => {
  const h = harness();
  const text = "Only the active task can be completed.";
  const result = { content: [{ type: "text", text }], details: {} };
  const render = h.tool.renderResult! as Function;
  for (const expanded of [false, true]) {
    assert.equal(render(result, { expanded }, { fg: (_color: string, text: string) => text }, {}).render(200).join("\n").trimEnd(), text);
  }
});

test("lists avoid duplicate checkpoints but preserve closure hints and hidden-view context", async () => {
  const h = harness();
  const parent = activeTask((await h.call({ action: "add", title: "Parent" })).details!.state)!.id;
  await h.call({ action: "add", title: "Child", parent });
  await h.call({ action: "complete", id: parent, outcome: "Own work." });
  const listed = await h.call({ action: "list" });
  const text = listed.content[0].type === "text" ? listed.content[0].text : "";
  assert.equal(text, `${listed.details!.response}\nancestorOutcomes: [${parent}]`);
  const hidden = await h.call({ action: "list", visibility: "hidden" });
  assert.match(hidden.content[0].type === "text" ? hidden.content[0].text : "", /Active task .*Child.*ancestorOutcomes/);
});

test("mutation feedback keeps titles and qualifies only explicit positioning", async () => {
  const h = harness();
  const first = await h.call({ action: "add", title: "First" });
  const a = activeTask(first.details!.state)!.id;
  assert.equal(first.details!.response, `Task [${a}] added: First`);
  assert.doesNotMatch(first.details!.response, /Position|Parent/);
  const second = await h.call({ action: "add", title: "Second", after: a });
  const b = second.details!.state.tasks[1].id;
  assert.equal(second.details!.response, `Task [${b}] added: Second\nPosition: after sibling [${a}]`);
  const child = await h.call({ action: "add", title: "Child", parent: a });
  const c = child.details!.affectedIds[0];
  assert.equal(child.details!.response, `Task [${c}] added: Child\nParent: [${a}]`);
  const moved = await h.call({ action: "move", id: b, parent: a, before: c });
  assert.equal(moved.details!.response, `Task [${b}] moved: Second\nParent: [${a}]\nPosition: before sibling [${c}]`);
});

test("default visibility applies only without a saved snapshot", async () => {
  const settings = { tasks: { defaultVisibility: "hidden" } };
  const h = harness(settings);
  h.emit("session_start");
  const added = await h.call({ action: "add", title: "Work" });
  assert.equal(added.details!.state.visibility, "hidden");
  assert.deepEqual(h.widgetLines(), []);
  await h.command.handler("all", h.ctx);
  settings.tasks.defaultVisibility = "active";
  h.emit("session_start");
  assert.equal((await h.call({ action: "list" })).details!.state.visibility, "all");
  h.entries.length = 0;
  h.emit("session_tree");
  assert.equal((await h.call({ action: "list" })).details!.state.visibility, "active");
  for (const value of [null, "invalid", 0]) {
    const invalid = harness({ tasks: { defaultVisibility: value } });
    invalid.emit("session_start");
    assert.match(invalid.notifications[0], /defaultVisibility/);
    assert.equal((await invalid.call({ action: "list" })).details!.state.visibility, "incomplete");
  }
});

test("reminders default to thirty top-level events, preserve history, and refresh after restore/compaction", async () => {
  const h = harness();
  const state = transition(emptyState(), { action: "add", title: "Active work" }, "seed");
  h.entries.push({ type: "custom", customType: "tasks-state", data: state });
  h.emit("session_start");
  const initial = h.emit("before_agent_start", { messageType: "user" });
  assert.equal(initial.message.display, true);
  assert.match(initial.message.content, /Active work/);
  h.emit("message_end", { message: { role: "user" } });
  for (let i = 0; i < 29; i++) h.emit("tool_result", { toolName: "read" });
  assert.equal(h.emit("turn_end", { entries: [] }), undefined);
  for (let i = 0; i < 50; i++) h.emit("tool_result", { toolName: "read", parentToolCallId: "nested" });
  assert.equal(h.emit("turn_end", { entries: [] }), undefined);
  h.emit("tool_result", { toolName: "read" });
  const existing = { type: "custom", customType: "another-extension", data: 1 };
  const periodic = h.emit("turn_end", { entries: [existing] });
  assert.equal(periodic.entries[0], existing);
  assert.equal(periodic.entries[1].type, "custom_message");
  assert.equal(periodic.entries[1].display, true);
  assert.equal(periodic.continue, undefined);
  assert.equal(h.emit("turn_end", { entries: [] }), undefined);
  h.emit("session_compact");
  assert.ok(h.emit("turn_end", { entries: [] }));

  // Twenty-nine tool completions plus user input trigger a checkpoint without double-counting input.
  for (let i = 0; i < 29; i++) h.emit("tool_result", { toolName: "read" });
  assert.ok(h.emit("before_agent_start", { messageType: "user" }));
  h.emit("message_end", { message: { role: "user" } });
  for (let i = 0; i < 29; i++) h.emit("message_end", { message: { role: "user" } });
  assert.equal(h.emit("turn_end", { entries: [] }), undefined);
  h.emit("message_end", { message: { role: "user" } });
  assert.ok(h.emit("turn_end", { entries: [] }));

  await h.call({ action: "complete", id: activeTask(state)!.id, outcome: "Finished." });
  for (let i = 0; i < 30; i++) h.emit("tool_result", { toolName: "read" });
  assert.equal(h.emit("turn_end", { entries: [] }), undefined);
});

test("completion resets the ticker for the next task and reminders render as visible output", async () => {
  const h = harness({ tasks: { reminderInterval: 3 } });
  h.emit("session_start");
  const first = await h.call({ action: "add", title: "First" });
  const id = activeTask(first.details!.state)!.id;
  await h.call({ action: "add", title: "Second" });
  for (let i = 0; i < 2; i++) h.emit("tool_result", { toolName: "read" });
  await h.call({ action: "complete", id, outcome: "Done." });
  assert.equal(h.emit("turn_end", { entries: [] }), undefined);
  for (let i = 0; i < 2; i++) h.emit("tool_result", { toolName: "read" });
  assert.equal(h.emit("turn_end", { entries: [] }), undefined);
  h.emit("tool_result", { toolName: "read" });
  const periodic = h.emit("turn_end", { entries: [] });
  const message = periodic.entries[0];
  assert.equal(message.display, true);
  assert.match(message.content, /Active task .*Second/);
  assert.equal(periodic.continue, undefined);
  const styles: string[] = [];
  const renderer = h.renderers.get("tasks-reminder")!;
  const text = renderer(message, { expanded: false }, { fg: (color: string, text: string) => { styles.push(color); return text; } }).render(200).join("\n").trimEnd();
  assert.equal(text, message.content);
  assert.deepEqual(styles, ["toolOutput"]);
});

test("configured intervals apply at session start and invalid settings warn and fall back to thirty", () => {
  const state = transition(emptyState(), { action: "add", title: "Active work" }, "seed");
  const settings = { tasks: { reminderInterval: 3 } };
  const h = harness(settings);
  h.entries.push({ type: "custom", customType: "tasks-state", data: state });
  h.emit("session_start");
  h.emit("before_agent_start", { messageType: "user" });
  h.emit("message_end", { message: { role: "user" } });
  for (let i = 0; i < 2; i++) h.emit("tool_result", { toolName: "read" });
  assert.equal(h.emit("turn_end", { entries: [] }), undefined);
  assert.ok(h.emit("before_agent_start", { messageType: "user" }));
  settings.tasks.reminderInterval = 1;
  h.emit("session_start");
  assert.ok(h.emit("before_agent_start", { messageType: "custom" }));
  h.emit("tool_result", { toolName: "read" });
  assert.ok(h.emit("turn_end", { entries: [] }));

  for (const tasks of [{ reminderInterval: 0 }, { reminderInterval: -1 }, { reminderInterval: 1.5 }, { reminderInterval: "30" }, { reminderInterval: null }, { reminderInterval: Number.MAX_SAFE_INTEGER + 1 }, null, []]) {
    const invalid = harness({ tasks });
    invalid.entries.push({ type: "custom", customType: "tasks-state", data: state });
    invalid.emit("session_start");
    assert.match(invalid.notifications[0], /default interval of 30/);
    invalid.emit("before_agent_start", { messageType: "custom" });
    for (let i = 0; i < 29; i++) invalid.emit("tool_result", { toolName: "read" });
    assert.equal(invalid.emit("turn_end", { entries: [] }), undefined);
    invalid.emit("tool_result", { toolName: "read" });
    assert.ok(invalid.emit("turn_end", { entries: [] }));
  }
});

test("corrupt snapshots fail closed and persistence failures roll back in-memory mutations", async () => {
  const corrupt = harness();
  corrupt.entries.push({ type: "custom", customType: "tasks-state", data: { version: 999 } });
  corrupt.emit("session_start");
  await assert.rejects(corrupt.call({ action: "add", title: "Overwrite" }), /unavailable/);
  assert.equal(corrupt.entries.length, 1);
  assert.match(corrupt.notifications[0], /restoration failed/);
  const h = harness();
  const added = await h.call({ action: "add", title: "Original" });
  h.failWrites();
  await assert.rejects(h.call({ action: "add", title: "Not saved" }), /Disk unavailable/);
  const listed = await h.call({ action: "list" });
  assert.deepEqual(listed.details!.state, added.details!.state);
});
