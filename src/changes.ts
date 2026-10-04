import { generateDiffString } from "@earendil-works/pi-coding-agent";

/** Rendering metadata only: never add this payload to model-facing content. */
export const DETAILS_KEY = "piCodemodeDiff";

export interface Change {
  toolCallId: string;
  tool: "edit" | "write";
  path: string;
  kind: "edit" | "create" | "overwrite" | "unknown";
  diff?: string;
  note?: string;
  /** A write can complete before the tool observes cancellation. */
  toolReportedError?: boolean;
}

export interface DiffDetails {
  version: 1;
  changes: Change[];
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Validate persisted data rather than trusting a resumed session's details. */
export function readChanges(details: unknown): Change[] | undefined {
  const payload = asRecord(asRecord(details)?.[DETAILS_KEY]);
  if (payload?.version !== 1 || !Array.isArray(payload.changes)) return undefined;
  const valid = payload.changes.every((value: unknown) => {
    const item = asRecord(value);
    return item !== undefined &&
      typeof item.toolCallId === "string" &&
      (item.tool === "edit" || item.tool === "write") &&
      typeof item.path === "string" &&
      typeof item.kind === "string" &&
      ["edit", "create", "overwrite", "unknown"].includes(item.kind) &&
      (item.diff === undefined || typeof item.diff === "string") &&
      (item.note === undefined || typeof item.note === "string") &&
      (item.toolReportedError === undefined || typeof item.toolReportedError === "boolean");
  });
  return valid ? payload.changes as Change[] : undefined;
}

export function countChanges(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  // Pi's display diff uses +<line number> / -<line number>, not patch headers.
  for (const line of diff.split("\n")) {
    if (/^\+\s*\d+ /.test(line)) added++;
    if (/^-\s*\d+ /.test(line)) removed++;
  }
  return { added, removed };
}

export type BeforeWrite =
  | { kind: "missing" }
  | { kind: "text"; content: string }
  | { kind: "unavailable"; reason: string };

function displayText(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** The snapshot is used for presentation, not retained as a file backup. */
export function writeChange(
  toolCallId: string,
  path: string,
  before: BeforeWrite,
  content: string,
): Change {
  const base: Change = {
    toolCallId,
    tool: "write",
    path,
    kind: before.kind === "missing" ? "create" : before.kind === "text" ? "overwrite" : "unknown",
  };
  if (before.kind === "unavailable") return { ...base, note: before.reason };
  if (content.includes("\0")) return { ...base, note: "Binary content; text diff unavailable." };

  const oldContent = before.kind === "missing" ? "" : before.content;
  const oldDisplay = displayText(oldContent);
  const newDisplay = displayText(content);
  const diff = generateDiffString(oldDisplay, newDisplay).diff;
  let note: string | undefined;
  if (before.kind === "missing" && content.length === 0) {
    note = "Created an empty file.";
  } else if (oldContent === content) {
    note = "No content changes.";
  } else if (oldDisplay === newDisplay) {
    note = "Only line endings or the UTF-8 BOM changed (normalized in this view).";
  }
  return { ...base, diff, ...(note ? { note } : {}) };
}
