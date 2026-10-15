export const DEFAULT_REMINDER_INTERVAL = 30;

function validateInterval(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("tasks.reminderInterval must be a positive safe integer.");
  }
  return value;
}

export function readReminderInterval(settings: unknown): number {
  const tasks = (settings as { tasks?: unknown }).tasks;
  if (tasks === undefined) return DEFAULT_REMINDER_INTERVAL;
  if (tasks === null || typeof tasks !== "object" || Array.isArray(tasks)) throw new Error("tasks settings must be a JSON object.");
  const interval = (tasks as { reminderInterval?: unknown }).reminderInterval;
  return interval === undefined ? DEFAULT_REMINDER_INTERVAL : validateInterval(interval);
}

export class ReminderCadence {
  private count = 0;
  private pending = true;
  private readonly interval: number;

  constructor(interval = DEFAULT_REMINDER_INTERVAL) {
    this.interval = validateInterval(interval);
  }

  tick(): void {
    if (++this.count >= this.interval) this.pending = true;
  }

  force(): void {
    this.pending = true;
  }

  reset(): void {
    this.count = 0;
    this.pending = false;
  }

  take(): boolean {
    if (!this.pending) return false;
    this.reset();
    return true;
  }
}
