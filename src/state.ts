import { createHash, randomBytes } from "node:crypto";
import { stripVTControlCharacters } from "node:util";

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ID_COUNT = ID_ALPHABET.length * ID_ALPHABET.length;
const encodeId = (value: number): string => ID_ALPHABET[Math.floor(value / ID_ALPHABET.length)] + ID_ALPHABET[value % ID_ALPHABET.length];

export type Visibility = "hidden" | "active" | "incomplete" | "all";
export type NoteVisibility = "all" | "active" | "none";
export interface TaskNote {
  id: string;
  taskId: string;
  text: string;
  createdAt: number;
  retractedAt?: number;
  reason?: string;
}
export type NoteAction = { action: "record"; text: string } | { action: "retract"; id: string; reason: string };
export type Status = "future" | "active" | "waiting" | "completed" | "cancelled";
export interface Task {
  id: string;
  title: string;
  parent: string | null;
  status: Status;
  disposition?: "completed" | "cancelled";
  ownOutcome?: string;
  outcome?: string;
}
export interface TaskState {
  version: 2;
  tasks: Task[];
  visibility: Visibility;
  notes: TaskNote[];
  noteVisibility: NoteVisibility;
}
export type Action =
  | { action: "add"; title: string; parent?: string | null; before?: string; after?: string }
  | { action: "move"; id: string; parent?: string | null; before?: string; after?: string; ancestorOutcomes?: Record<string, string> }
  | { action: "edit"; id: string; title: string }
  | { action: "complete"; id: string; outcome: string; ancestorOutcomes?: Record<string, string> }
  | { action: "cancel"; id: string; reason?: string; ancestorOutcomes?: Record<string, string> };

export const emptyState = (visibility: Visibility = "incomplete", noteVisibility: NoteVisibility = "active"): TaskState => ({ version: 2, tasks: [], visibility, notes: [], noteVisibility });
export const terminal = (task: Task): boolean => task.status === "completed" || task.status === "cancelled";
export const activeTask = (state: TaskState): Task | undefined => state.tasks.find((task) => task.status === "active");

function requiredText(text: string, label: string): string {
  if (typeof text !== "string" || !text.trim()) throw new Error(`${label} must not be empty.`);
  return text.trim();
}
function findTask(state: TaskState, id: string): Task {
  const task = state.tasks.find((task) => task.id === id);
  if (!task) throw new Error(`Unknown task ${id}.`);
  return task;
}
function children(state: TaskState, id: string): Task[] {
  return state.tasks.filter((task) => task.parent === id);
}
function subtreeEnd(state: TaskState, index: number): number {
  const ids = new Set([state.tasks[index].id]);
  let end = index + 1;
  while (end < state.tasks.length && ids.has(state.tasks[end].parent ?? "")) {
    ids.add(state.tasks[end].id);
    end++;
  }
  return end;
}

// IDs are allocated once. Linear probing resolves the inevitable short-hash collisions.
function allocateRecordId(records: readonly { id: string }[], kind: "task" | "note", seed = randomBytes(16).toString("hex")): string {
  if (records.length >= ID_COUNT) throw new Error(`All ${ID_COUNT} two-character ${kind} IDs have been used in this history.`);
  const used = new Set(records.map((record) => record.id));
  const start = createHash("sha256").update(seed).digest().readUInt32BE(0) % ID_COUNT;
  for (let offset = 0; offset < ID_COUNT; offset++) {
    const id = encodeId((start + offset) % ID_COUNT);
    if (!used.has(id)) return id;
  }
  throw new Error(`${kind} ID space exhausted.`);
}

export const allocateId = (state: TaskState, seed?: string): string => allocateRecordId(state.tasks, "task", seed);
export const allocateNoteId = (state: TaskState, seed?: string): string => allocateRecordId(state.notes, "note", seed);

export function findNote(state: TaskState, id: string): TaskNote {
  const note = state.notes.find((note) => note.id === id);
  if (!note) throw new Error(`Unknown note ${id}.`);
  return note;
}

export function transitionNote(state: TaskState, action: NoteAction, seed?: string, now = Date.now()): TaskState {
  const next = structuredClone(state);
  if (action.action === "record") {
    const owner = activeTask(next);
    if (!owner) throw new Error("An active task is required to record a note.");
    requiredText(action.text, "Note text");
    next.notes.push({ id: allocateNoteId(next, seed), taskId: owner.id, text: action.text, createdAt: now });
  } else if (action.action === "retract") {
    const note = findNote(next, action.id);
    if (note.retractedAt !== undefined) throw new Error(`Note [${note.id}] is already retracted.`);
    note.reason = requiredText(action.reason, "Retraction reason");
    note.retractedAt = now;
  } else throw new Error("Unknown note action.");
  validateState(next);
  return next;
}

export function describeNote(state: TaskState, note: TaskNote): string {
  const owner = findTask(state, note.taskId);
  return `Note [${note.id}] ${note.retractedAt === undefined ? "active" : "retracted"}\nTask [${owner.id}]: ${owner.title}\nCreated: ${new Date(note.createdAt).toISOString()}\nText:\n${note.text}${note.retractedAt === undefined ? "" : `\nRetracted: ${new Date(note.retractedAt).toISOString()}\nReason: ${note.reason}`}`;
}

function insertionIndex(state: TaskState, parent: string | null, before?: string, after?: string): number {
  if (before !== undefined && after !== undefined) throw new Error("Use before or after, not both.");
  if (parent !== null && terminal(findTask(state, parent))) throw new Error("Cannot add children to a closed parent.");
  const anchorId = before ?? after;
  if (anchorId !== undefined) {
    const anchor = findTask(state, anchorId);
    if (anchor.parent !== parent) throw new Error("Position anchor must have the same parent as the moved/added task.");
    const index = state.tasks.indexOf(anchor);
    return before !== undefined ? index : subtreeEnd(state, index);
  }
  return parent === null ? state.tasks.length : subtreeEnd(state, state.tasks.findIndex((task) => task.id === parent));
}

function advance(state: TaskState): void {
  if (!activeTask(state)) {
    const next = state.tasks.find((task) => task.status === "future");
    if (next) next.status = "active";
  }
}

function closeWaiting(state: TaskState, summaries: Record<string, string> = {}): string[] {
  const closed: string[] = [];
  // Reverse preorder closes descendants before their ancestors, including cascading closure.
  for (const task of state.tasks.toReversed()) {
    if (task.status !== "waiting" || !children(state, task.id).every(terminal)) continue;
    task.status = task.disposition!;
    task.outcome = task.status === "completed" ? summaries[task.id]?.trim() : task.ownOutcome;
    closed.push(task.id);
  }
  const missing = closed.filter((id) => {
    const task = findTask(state, id);
    return task.status === "completed" && !task.outcome;
  });
  if (missing.length) throw new Error(`Include ancestorOutcomes for closing parents: ${missing.map((id) => `[${id}] ${findTask(state, id).title}`).join(", ")}. No tasks changed.`);
  return closed;
}

export function transition(state: TaskState, action: Action, seed?: string): TaskState {
  const next = structuredClone(state);
  switch (action.action) {
    case "add": {
      const parent = action.parent ?? null;
      const index = insertionIndex(next, parent, action.before, action.after);
      const activeIndex = next.tasks.findIndex((task) => task.status === "active");
      if (activeIndex >= 0 ? index <= activeIndex : index < next.tasks.length) throw new Error("New tasks must be inserted after the execution frontier.");
      next.tasks.splice(index, 0, { id: allocateId(next, seed), title: requiredText(action.title, "Title"), parent, status: "future" });
      break;
    }
    case "move": {
      const task = findTask(next, action.id);
      const start = next.tasks.indexOf(task);
      const end = subtreeEnd(next, start);
      const block = next.tasks.slice(start, end);
      if (block.some((item) => item.status !== "future")) throw new Error("Only wholly future subtrees can be moved.");
      if (action.parent === undefined && action.before === undefined && action.after === undefined) throw new Error("Specify a new parent or position.");
      const parent = action.parent === undefined ? task.parent : action.parent;
      if (block.some((item) => item.id === parent || item.id === action.before || item.id === action.after)) throw new Error("A subtree cannot be moved into or positioned against itself.");
      next.tasks.splice(start, end - start);
      const index = insertionIndex(next, parent, action.before, action.after);
      const activeIndex = next.tasks.findIndex((item) => item.status === "active");
      if (index <= activeIndex) throw new Error("Cannot move tasks behind the execution frontier.");
      task.parent = parent;
      next.tasks.splice(index, 0, ...block);
      closeWaiting(next, action.ancestorOutcomes);
      break;
    }
    case "edit":
      findTask(next, action.id).title = requiredText(action.title, "Title");
      break;
    case "complete":
    case "cancel": {
      const task = findTask(next, action.id);
      if (action.action === "complete" && task.status !== "active") throw new Error("Only the active task can be completed.");
      if (action.action === "cancel" && task.status !== "active" && task.status !== "future") throw new Error("Only active or future tasks can be cancelled.");
      const outcome = action.action === "complete" ? requiredText(action.outcome, "Outcome") : action.reason?.trim() || "Cancelled.";
      const disposition = action.action === "complete" ? "completed" : "cancelled";
      task.ownOutcome = outcome;
      task.disposition = disposition;
      if (children(next, task.id).some((child) => !terminal(child))) {
        task.status = "waiting";
      } else {
        task.status = disposition;
        task.outcome = outcome;
      }
      closeWaiting(next, action.ancestorOutcomes);
      break;
    }
    default:
      throw new Error("Unknown task action.");
  }
  advance(next);
  validateState(next);
  return next;
}

export function closingParents(state: TaskState, id: string): string[] {
  const next = structuredClone(state);
  const task = findTask(next, id);
  if (children(next, id).some((child) => !terminal(child))) return [];
  task.status = "completed";
  const closing: string[] = [];
  for (const parent of next.tasks.toReversed()) {
    if (parent.status !== "waiting" || !children(next, parent.id).every(terminal)) continue;
    parent.status = parent.disposition!;
    if (parent.status === "completed") closing.push(parent.id);
  }
  return closing;
}

export function reminder(state: TaskState): string {
  const active = activeTask(state);
  if (!active) return "No active task.";
  const path: string[] = [];
  let parent = active.parent;
  while (parent !== null) {
    const task = findTask(state, parent);
    path.unshift(`[${task.id}] ${task.title}`);
    parent = task.parent;
  }
  const closing = closingParents(state, active.id);
  return `Active task [${active.id}]: ${active.title}${path.length ? ` | Parents: ${path.join(" / ")}` : ""}${closing.length ? ` | ancestorOutcomes: ${closing.map((id) => `[${id}]`).join(", ")}` : ""}`;
}

export function validateState(state: TaskState): void {
  if (!state || state.version !== 2 || !["hidden", "active", "incomplete", "all"].includes(state.visibility) || !Array.isArray(state.tasks) || !Array.isArray(state.notes) || !["all", "active", "none"].includes(state.noteVisibility)) throw new Error("Invalid tasks snapshot.");
  const seen = new Set<string>();
  const path: string[] = [];
  let activeCount = 0;
  let futureSeen = false;
  for (const task of state.tasks) {
    if (!/^[0-9a-zA-Z]{2}$/.test(task.id) || seen.has(task.id)) throw new Error("Invalid or duplicate task ID.");
    requiredText(task.title, "Title");
    if (!["future", "active", "waiting", "completed", "cancelled"].includes(task.status)) throw new Error("Invalid task status.");
    if (task.parent !== null) {
      const depth = path.indexOf(task.parent);
      if (depth < 0) throw new Error("Invalid parent or non-contiguous subtree.");
      path.length = depth + 1;
      if (terminal(findTask(state, task.parent)) && !terminal(task)) throw new Error("Closed parents cannot have incomplete children.");
    } else path.length = 0;
    path.push(task.id);
    seen.add(task.id);
    if (task.status === "future") futureSeen = true;
    if (task.status === "active") {
      if (futureSeen) throw new Error("Active task must precede all future tasks.");
      activeCount++;
    }
    if (task.status === "waiting" && (!["completed", "cancelled"].includes(task.disposition ?? "") || !task.ownOutcome)) throw new Error("Waiting parents need a disposition and own-work outcome.");
    if (task.status === "completed" && !task.outcome?.trim()) throw new Error("Completed tasks need an outcome.");
  }
  const noteIds = new Set<string>();
  const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
  for (const note of state.notes) {
    if (!note || !/^[0-9a-zA-Z]{2}$/.test(note.id) || noteIds.has(note.id)) throw new Error("Invalid or duplicate note ID.");
    if (!seen.has(note.taskId)) throw new Error("Note refers to an unknown task.");
    requiredText(note.text, "Note text");
    if (!validTime(note.createdAt) || (note.retractedAt !== undefined && !validTime(note.retractedAt))) throw new Error("Invalid note timestamp.");
    if ((note.retractedAt !== undefined) !== (note.reason !== undefined)) throw new Error("Retracted notes need a timestamp and reason.");
    if (note.reason !== undefined) requiredText(note.reason, "Retraction reason");
    if (Object.keys(note).some((key) => !["id", "taskId", "text", "createdAt", "retractedAt", "reason"].includes(key))) throw new Error("Invalid note fields.");
    noteIds.add(note.id);
  }
  if (activeCount > 1 || (activeCount === 0 && state.tasks.some((task) => task.status === "future"))) throw new Error("Invalid active task count.");
  if (state.tasks.some((task) => task.status === "waiting" && children(state, task.id).every(terminal))) throw new Error("Resolved parents must close automatically.");
}

export function restoreState(entries: readonly { type: string; customType?: string; data?: unknown }[], defaultVisibility: Visibility = "incomplete", defaultNoteVisibility: NoteVisibility = "active"): TaskState {
  const entry = entries.findLast((item) => item.type === "custom" && item.customType === "tasks-state");
  if (!entry) return emptyState(defaultVisibility, defaultNoteVisibility);
  const snapshot = structuredClone(entry.data) as Record<string, unknown>;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Invalid tasks snapshot.");
  if (snapshot.version === 1 && ("notes" in snapshot || "noteVisibility" in snapshot)) throw new Error("Invalid legacy tasks snapshot.");
  // SAFETY: validateState checks the migrated, untrusted snapshot before it is returned.
  const state = (snapshot.version === 1 ? { ...snapshot, version: 2, notes: [], noteVisibility: defaultNoteVisibility } : snapshot) as unknown as TaskState;
  validateState(state);
  return state;
}

const singleLine = (text: string): string => stripVTControlCharacters(text).replace(/\s+/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();

export function treeLines(state: TaskState, visibility: Visibility = state.visibility, format: "display" | "text" = "display", noteVisibility: NoteVisibility = format === "text" ? "all" : (state.noteVisibility ?? "active")): string[] {
  if (visibility === "hidden") return [];
  const included = new Set(state.tasks.filter((task) => visibility === "all" || (visibility === "active" ? task.status === "active" : !terminal(task))).map((task) => task.id));
  for (const id of [...included]) {
    let parent = findTask(state, id).parent;
    while (parent !== null) {
      included.add(parent);
      parent = findTask(state, parent).parent;
    }
  }
  const notesByTask = new Map<string, TaskNote[]>();
  // Historical tool-result snapshots may predate notes; durable state is validated separately.
  for (const note of state.notes ?? []) {
    if (noteVisibility === "none" || (noteVisibility === "active" && note.retractedAt !== undefined)) continue;
    const notes = notesByTask.get(note.taskId) ?? [];
    notes.push(note);
    notesByTask.set(note.taskId, notes);
  }
  const symbols: Record<Status, string> = { future: "○", active: "▶", waiting: "…", completed: "✓", cancelled: "×" };
  const depths = new Map<string, number>();
  return state.tasks.flatMap((task) => {
    const depth = task.parent === null ? 0 : depths.get(task.parent)! + 1;
    depths.set(task.id, depth);
    if (!included.has(task.id)) return [];
    const title = format === "display" ? singleLine(task.title) : task.title;
    return [
      `${"  ".repeat(depth)}${format === "text" ? task.status : symbols[task.status]} [${task.id}] ${title}`,
      ...(notesByTask.get(task.id) ?? []).map((note) => {
        const retracted = note.retractedAt !== undefined;
        const prefix = format === "text" ? `note ${retracted ? "retracted" : "active"}` : retracted ? "⊘ note" : "◆ note";
        const text = note.text + (retracted ? ` | Reason: ${note.reason}` : "");
        return `${"  ".repeat(depth + 1)}${prefix} [${note.id}] ${format === "display" ? singleLine(text) : text}`;
      }),
    ];
  });
}
