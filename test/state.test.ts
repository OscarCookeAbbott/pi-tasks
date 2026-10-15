import assert from "node:assert/strict";
import { test } from "node:test";
import { activeTask, allocateId, closingParents, emptyState, reminder, restoreState, transition, treeLines, validateState, type TaskState } from "../src/state.ts";

function add(state: TaskState, title: string, options: { parent?: string | null; before?: string; after?: string } = {}): [TaskState, string] {
  const next = transition(state, { action: "add", title, ...options }, title);
  return [next, next.tasks.find((task) => !state.tasks.some((old) => old.id === task.id))!.id];
}

function nestedPlan(): { state: TaskState; root: string; branch: string; leaf: string; next: string } {
  let [state, root] = add(emptyState(), "Build feature");
  let branch: string, leaf: string, next: string;
  [state, branch] = add(state, "Implement", { parent: root });
  [state, leaf] = add(state, "Test", { parent: branch });
  [state, next] = add(state, "Ship");
  state = transition(state, { action: "complete", id: root, outcome: "Designed feature." });
  state = transition(state, { action: "complete", id: branch, outcome: "Implemented feature." });
  return { state, root, branch, leaf, next };
}

test("insertion, sibling reordering, and title edits preserve IDs and the single active task", () => {
  let [state, a] = add(emptyState(), "First");
  let b: string, c: string;
  [state, b] = add(state, "Last");
  [state, c] = add(state, "Middle", { before: b });
  assert.deepEqual(state.tasks.map((task) => task.id), [a, c, b]);
  state = transition(state, { action: "move", id: b, before: c });
  state = transition(state, { action: "edit", id: b, title: "Renamed" });
  assert.deepEqual(state.tasks.map((task) => task.id), [a, b, c]);
  assert.equal(state.tasks[1].title, "Renamed");
  assert.equal(activeTask(state)?.id, a);
  state = transition(state, { action: "complete", id: a, outcome: "First done." });
  assert.equal(activeTask(state)?.id, b);
  assert.equal(state.tasks.filter((task) => task.status === "active").length, 1);
});

test("forward-only mutations reject skips, reopening, historical insertion, and invalid summaries atomically", () => {
  let [state, a] = add(emptyState(), "First");
  let b: string;
  [state, b] = add(state, "Second");
  const unchanged = structuredClone(state);
  for (const action of [
    { action: "complete", id: b, outcome: "Skipped" },
    { action: "complete", id: a, outcome: "  " },
    { action: "move", id: b, before: a },
    { action: "move", id: a, after: b },
    { action: "add", title: "Historical", before: a },
    { action: "add", title: "Missing parent", parent: "??" },
    { action: "add", title: "Conflicting", before: b, after: b },
  ] as const) {
    assert.throws(() => transition(state, action));
    assert.deepEqual(state, unchanged);
  }
  state = transition(state, { action: "complete", id: a, outcome: "Done." });
  assert.throws(() => transition(state, { action: "complete", id: a, outcome: "Again" }), /active/);
  assert.throws(() => transition(state, { action: "cancel", id: a }), /active or future/);
  state = transition(state, { action: "complete", id: b, outcome: "Done." });
  assert.throws(() => add(state, "Past", { before: a }), /frontier/);
  const [extended, c] = add(state, "New work");
  assert.equal(activeTask(extended)?.id, c);
});

test("final child closes multiple ancestors with mandatory summaries in one atomic transition", () => {
  const { state, root, branch, leaf, next } = nestedPlan();
  assert.equal(activeTask(state)?.id, leaf);
  assert.deepEqual(closingParents(state, leaf), [branch, root]);
  assert.equal(reminder(state), `[Tasks] Active [${leaf}] Test | Parents: [${root}] Build feature / [${branch}] Implement | ancestorOutcomes: [${branch}], [${root}]`);
  const unchanged = structuredClone(state);
  assert.throws(() => transition(state, { action: "complete", id: leaf, outcome: "Tests pass.", ancestorOutcomes: { [branch]: "Branch done." } }), (error: unknown) => error instanceof Error && error.message.includes(`[${root}] Build feature`));
  assert.deepEqual(state, unchanged);
  const completed = transition(state, { action: "complete", id: leaf, outcome: "Tests pass.", ancestorOutcomes: { [branch]: "Implemented and tested.", [root]: "Feature ready." } });
  assert.deepEqual(completed.tasks.slice(0, 3).map((task) => task.status), ["completed", "completed", "completed"]);
  assert.equal(completed.tasks[0].ownOutcome, "Designed feature.");
  assert.equal(completed.tasks[0].outcome, "Feature ready.");
  assert.equal(activeTask(completed)?.id, next);
});

test("cancellation preserves children, pending disposition, and completion summaries for mixed ancestors", () => {
  let [state, parent] = add(emptyState(), "Parent");
  let child: string, later: string;
  [state, child] = add(state, "Child", { parent });
  [state, later] = add(state, "Later");
  state = transition(state, { action: "cancel", id: parent, reason: "Parent abandoned." });
  assert.equal(state.tasks[0].status, "waiting");
  assert.equal(activeTask(state)?.id, child);
  assert.equal(state.tasks[1].status, "active");
  state = transition(state, { action: "complete", id: child, outcome: "Child done." });
  assert.equal(state.tasks[0].status, "cancelled");
  assert.equal(state.tasks[0].outcome, "Parent abandoned.");
  assert.equal(activeTask(state)?.id, later);

  const plan = nestedPlan();
  const closed = transition(plan.state, { action: "cancel", id: plan.leaf, ancestorOutcomes: { [plan.branch]: "No test needed.", [plan.root]: "Finished without testing." } });
  assert.equal(closed.tasks[0].status, "completed");
  assert.equal(closed.tasks[2].status, "cancelled");
});

test("cancelling future parents does not jump the active task or cancel descendants", () => {
  let [state, first] = add(emptyState(), "First");
  let parent: string, child: string;
  [state, parent] = add(state, "Future parent");
  [state, child] = add(state, "Future child", { parent });
  state = transition(state, { action: "cancel", id: parent });
  assert.equal(activeTask(state)?.id, first);
  assert.equal(state.tasks[1].status, "waiting");
  assert.equal(state.tasks[2].status, "future");
  state = transition(state, { action: "complete", id: first, outcome: "Done." });
  assert.equal(activeTask(state)?.id, child);
  state = transition(state, { action: "cancel", id: child });
  assert.equal(state.tasks[1].status, "cancelled");
  assert.equal(activeTask(state), undefined);
});

test("move reparents whole subtrees, supports root/null and positioning, and rejects cycles and mismatched anchors", () => {
  let [state, first] = add(emptyState(), "Active");
  let parent: string, subtree: string, descendant: string, sibling: string;
  [state, parent] = add(state, "Destination");
  [state, sibling] = add(state, "Existing child", { parent });
  [state, subtree] = add(state, "Subtree");
  [state, descendant] = add(state, "Descendant", { parent: subtree });
  assert.throws(() => transition(state, { action: "move", id: subtree, parent: descendant }), /itself/);
  assert.throws(() => transition(state, { action: "move", id: subtree, parent, before: first }), /same parent/);
  state = transition(state, { action: "move", id: subtree, parent, before: sibling });
  assert.deepEqual(state.tasks.map((task) => task.id), [first, parent, subtree, descendant, sibling]);
  assert.equal(state.tasks[2].parent, parent);
  assert.equal(state.tasks[3].parent, subtree);
  state = transition(state, { action: "move", id: subtree, parent: null });
  assert.deepEqual(state.tasks.map((task) => task.id), [first, parent, sibling, subtree, descendant]);
  assert.equal(state.tasks[3].parent, null);
});

test("moving the last future child closes its old pending-cancellation parent", () => {
  let [other, current] = add(emptyState(), "Current");
  let oldParent: string, futureChild: string, newParent: string;
  [other, oldParent] = add(other, "Old parent");
  [other, futureChild] = add(other, "Movable", { parent: oldParent });
  [other, newParent] = add(other, "New parent");
  other = transition(other, { action: "cancel", id: oldParent });
  const moved = transition(other, { action: "move", id: futureChild, parent: newParent });
  assert.equal(moved.tasks.find((task) => task.id === oldParent)?.status, "cancelled");
  assert.equal(activeTask(moved)?.id, current);
  assert.equal(moved.tasks.find((task) => task.id === futureChild)?.parent, newParent);
});

test("waiting parents can receive more future children, but closed parents cannot", () => {
  let [state, parent] = add(emptyState(), "Parent");
  let child: string, extra: string;
  [state, child] = add(state, "First child", { parent });
  state = transition(state, { action: "complete", id: parent, outcome: "Own work done." });
  [state, extra] = add(state, "Extra child", { parent });
  assert.deepEqual(closingParents(state, child), []);
  state = transition(state, { action: "complete", id: child, outcome: "Done." });
  assert.deepEqual(closingParents(state, extra), [parent]);
  state = transition(state, { action: "complete", id: extra, outcome: "Done.", ancestorOutcomes: { [parent]: "All children done." } });
  assert.throws(() => add(state, "Too late", { parent }), /closed parent/);
});

test("short hash collisions are resolved without ID reuse and exhaustion is explicit", () => {
  let state = emptyState();
  for (let index = 0; index < 3844; index++) {
    const id = allocateId(state, "same seed");
    assert.match(id, /^[0-9a-zA-Z]{2}$/);
    assert.ok(!state.tasks.some((task) => task.id === id));
    state.tasks.push({ id, title: "Used", parent: null, status: "cancelled", outcome: "Cancelled." });
  }
  assert.equal(new Set(state.tasks.map((task) => task.id)).size, 3844);
  assert.throws(() => allocateId(state), /3844/);
});

test("snapshots restore the supplied branch, are isolated, and fail closed on corrupt data", () => {
  const [state] = add(emptyState(), "Branch A");
  const entries = [{ type: "custom", customType: "tasks-state", data: state }, { type: "custom", customType: "unrelated", data: {} }];
  const restored = restoreState(entries);
  assert.deepEqual(restored, state);
  restored.tasks[0].title = "Changed";
  assert.equal(state.tasks[0].title, "Branch A");
  assert.deepEqual(restoreState([]), emptyState());
  assert.deepEqual(restoreState([], "hidden"), emptyState("hidden"));
  assert.deepEqual(restoreState(entries, "hidden"), state);
  assert.throws(() => restoreState([{ type: "custom", customType: "tasks-state", data: { ...state, version: 2 } }]), /snapshot/);
  const corrupt = structuredClone(state);
  corrupt.tasks.push({ ...corrupt.tasks[0] });
  assert.throws(() => validateState(corrupt), /duplicate/);
});

test("all four views preserve ancestry and waiting parents while hiding terminal tasks", () => {
  const { state, root, leaf, next } = nestedPlan();
  assert.deepEqual(treeLines(state, "hidden"), []);
  const active = treeLines(state, "active");
  const branch = state.tasks[1].id;
  assert.deepEqual(active, [`… [${root}] Build feature`, `  … [${branch}] Implement`, `    ▶ [${leaf}] Test`]);
  assert.deepEqual(treeLines(state, "all", "text"), [
    `waiting [${root}] Build feature`,
    `  waiting [${branch}] Implement`,
    `    active [${leaf}] Test`,
    `future [${next}] Ship`,
  ]);
  assert.equal(treeLines(state, "incomplete").length, 4);
  const closed = transition(state, { action: "cancel", id: leaf, ancestorOutcomes: Object.fromEntries(closingParents(state, leaf).map((id) => [id, "Done."])) });
  assert.equal(treeLines(closed, "incomplete").length, 1);
  assert.match(treeLines(closed, "active")[0], new RegExp(next));
  assert.equal(treeLines(closed, "all").length, 4);
  assert.deepEqual(treeLines(closed, "all", "text"), [
    `completed [${root}] Build feature`,
    `  completed [${branch}] Implement`,
    `    cancelled [${leaf}] Test`,
    `active [${next}] Ship`,
  ]);
  assert.equal(reminder(closed), `[Tasks] Active [${next}] Ship`);
  assert.equal(reminder(emptyState()), "[Tasks] No active task.");
});
