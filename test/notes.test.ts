import assert from "node:assert/strict";
import { test } from "node:test";
import { activeTask, allocateNoteId, describeNote, emptyState, restoreState, transition, transitionNote, treeLines, validateState } from "../src/state.ts";

const start = () => transition(emptyState(), { action: "add", title: "Investigate" }, "task");

test("notes keep their original text, owner and creation time through task progression and retraction", () => {
  const initial = start();
  const owner = activeTask(initial)!.id;
  const text = "  Decision: use the existing service.\n";
  let state = transitionNote(initial, { action: "record", text }, "note", 1000);
  assert.equal(state.notes[0].text, text);
  const recorded = structuredClone(state.notes[0]);
  assert.deepEqual(initial.notes, []);
  assert.deepEqual(state.tasks, initial.tasks);
  state = transition(state, { action: "add", title: "Implement" }, "next");
  state = transition(state, { action: "complete", id: owner, outcome: "Investigation finished." });
  assert.notEqual(activeTask(state)!.id, owner);
  const before = structuredClone(state);
  state = transitionNote(state, { action: "retract", id: recorded.id, reason: "Superseded by a new discovery." }, undefined, 2000);
  assert.deepEqual(before.notes[0], recorded);
  assert.deepEqual(state.notes[0], { ...recorded, retractedAt: 2000, reason: "Superseded by a new discovery." });
  assert.deepEqual(state.tasks, before.tasks);
  assert.match(describeNote(state, state.notes[0]), /retracted\nTask \[.*\]: Investigate/);
  assert.match(describeNote(state, state.notes[0]), /Created: 1970-01-01T00:00:01.000Z/);
  assert.match(describeNote(state, state.notes[0]), /Decision: use the existing service\./);
  assert.equal(state.notes[0].taskId, owner);
});

test("invalid note operations reject atomically, including recording without active work and repeated retraction", () => {
  assert.throws(() => transitionNote(emptyState(), { action: "record", text: "Important" }), /active task/);
  const state = transitionNote(start(), { action: "record", text: "Discovery" }, "note", 0);
  const unchanged = structuredClone(state);
  for (const action of [
    { action: "record", text: " " },
    { action: "retract", id: state.notes[0].id, reason: " " },
    { action: "retract", id: "??", reason: "Wrong" },
    { action: "edit", id: state.notes[0].id, text: "Rewrite" },
  ] as const) {
    assert.throws(() => transitionNote(state, action as any));
    assert.deepEqual(state, unchanged);
  }
  const retracted = transitionNote(state, { action: "retract", id: state.notes[0].id, reason: "Incorrect" }, undefined, 0);
  assert.throws(() => transitionNote(retracted, { action: "retract", id: state.notes[0].id, reason: "Again" }), /already retracted/);
  const closed = transition(state, { action: "complete", id: activeTask(state)!.id, outcome: "Done" });
  assert.throws(() => transitionNote(closed, { action: "record", text: "Too late" }), /active task/);
  assert.doesNotThrow(() => transitionNote(closed, { action: "retract", id: state.notes[0].id, reason: "No longer relevant" }));
});

test("note IDs have a separate base-62 pool and retracted IDs are never reused", () => {
  const state = start();
  assert.equal(allocateNoteId(state, "task"), state.tasks[0].id);
  for (let index = 0; index < 3844; index++) {
    const id = allocateNoteId(state, "same seed");
    assert.match(id, /^[0-9a-zA-Z]{2}$/);
    assert.ok(!state.notes.some((note) => note.id === id));
    state.notes.push({ id, taskId: state.tasks[0].id, text: "Historical", createdAt: 0, retractedAt: 1, reason: "Withdrawn" });
  }
  validateState(state);
  assert.equal(new Set(state.notes.map((note) => note.id)).size, 3844);
  assert.throws(() => allocateNoteId(state), /3844.*note IDs/);
});

test("note filters are subordinate to visible tasks, preserve ancestry and never change task progress", () => {
  let state = start();
  const first = activeTask(state)!.id;
  state = transitionNote(state, { action: "record", text: "First discovery" }, "first note", 0);
  state = transition(state, { action: "add", title: "Parent" }, "parent");
  const parent = state.tasks[1].id;
  state = transition(state, { action: "add", title: "Child", parent }, "child");
  state = transition(state, { action: "complete", id: first, outcome: "Done" });
  state = transitionNote(state, { action: "record", text: "Old decision" }, "old note", 1);
  state = transitionNote(state, { action: "retract", id: state.notes[1].id, reason: "Replaced" }, undefined, 2);
  state = transition(state, { action: "complete", id: parent, outcome: "Own work done" });
  state = transitionNote(state, { action: "record", text: "New\ndiscovery\t\x1b[2A" }, "new note", 3);
  const active = treeLines(state, "active");
  assert.ok(!active.some((line) => /First discovery|Old decision/.test(line)));
  assert.ok(active.some((line) => /New discovery/.test(line)));
  assert.ok(active.every((line) => !/[\x00-\x1f\x7f-\x9f]/.test(line)));
  assert.ok(treeLines(state, "active", "display", "all").some((line) => /⊘ <[0-9a-zA-Z]{2}>.*Old decision.*Replaced/.test(line)));
  assert.equal(treeLines(state, "active", "display", "none").length, 2);
  assert.deepEqual(treeLines(state, "hidden", "display", "all"), []);
  assert.ok(treeLines(state, "all").some((line) => /First discovery/.test(line)));
  state.noteVisibility = "none";
  assert.ok(!treeLines(state, "all").some((line) => /^[\s]*[◆⊘] </.test(line)));
  const model = treeLines(state, "all", "text").join("\n");
  assert.match(model, /note retracted.*Old decision.*Replaced/);
  assert.equal(state.tasks.length, 3);
  assert.equal(activeTask(state)!.title, "Child");
});

test("v1 snapshots migrate without losing tasks; v2 snapshots retain notes and fail closed on corruption", () => {
  const initial = start();
  const legacy = { version: 1, tasks: initial.tasks, visibility: "all" };
  const entries = [{ type: "custom", customType: "tasks-state", data: legacy }];
  const migrated = restoreState(entries, "hidden", "none");
  assert.deepEqual(migrated, { ...initial, visibility: "all", noteVisibility: "none" });
  assert.equal(legacy.version, 1);
  const state = transitionNote(initial, { action: "record", text: "Keep this discovery" }, "note", 1000);
  const saved = [{ type: "custom", customType: "tasks-state", data: state }];
  const restored = restoreState(saved, "hidden", "none");
  assert.deepEqual(restored, state);
  restored.notes[0].text = "Changed copy";
  assert.equal(state.notes[0].text, "Keep this discovery");
  for (const corrupt of [
    { ...state, notes: undefined },
    { ...state, noteVisibility: "invalid" },
    { ...state, notes: [state.notes[0], state.notes[0]] },
    { ...state, notes: [{ ...state.notes[0], taskId: "??" }] },
    { ...state, notes: [{ ...state.notes[0], createdAt: NaN }] },
    { ...state, notes: [{ ...state.notes[0], retractedAt: 1 }] },
    { ...state, notes: [{ ...state.notes[0], reason: "Missing timestamp" }] },
    { ...state, notes: [{ ...state.notes[0], editable: true }] },
  ]) assert.throws(() => restoreState([{ type: "custom", customType: "tasks-state", data: corrupt }]));
  assert.deepEqual(restoreState([], "active", "all"), emptyState("active", "all"));
});
