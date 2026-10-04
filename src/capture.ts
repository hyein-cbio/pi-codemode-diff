import type { Change, DiffDetails } from "./changes.ts";

interface Call {
  rootId: string;
  order: number;
}

interface Batch {
  callIds: Set<string>;
  changes: Map<string, Change>;
  nextOrder: number;
  invalidate?: () => void;
}

/** Session-local, keyed by call id: parallel codemode calls cannot mix data. */
export class Capture {
  private calls = new Map<string, Call>();
  private batches = new Map<string, Batch>();

  start(id: string, name: string, parentId?: string): void {
    const parentRoot = parentId ? this.calls.get(parentId)?.rootId : undefined;
    if (!parentRoot && name !== "codemode") return;
    const rootId = parentRoot ?? id;
    let batch = this.batches.get(rootId);
    if (!batch) {
      batch = { callIds: new Set(), changes: new Map(), nextOrder: 0 };
      this.batches.set(rootId, batch);
    }
    batch.callIds.add(id);
    this.calls.set(id, { rootId, order: batch.nextOrder++ });
  }

  rootFor(id: string): string | undefined {
    return this.calls.get(id)?.rootId;
  }

  isNested(id: string): boolean {
    const root = this.rootFor(id);
    return root !== undefined && root !== id;
  }

  add(change: Change): void {
    const rootId = this.rootFor(change.toolCallId);
    const batch = rootId ? this.batches.get(rootId) : undefined;
    if (!batch) return;
    batch.changes.set(change.toolCallId, change);
    this.redraw(batch);
  }

  reportError(id: string): void {
    const rootId = this.rootFor(id);
    const batch = rootId ? this.batches.get(rootId) : undefined;
    const change = batch?.changes.get(id);
    if (!batch || !change) return;
    batch.changes.set(id, { ...change, toolReportedError: true });
    this.redraw(batch);
  }

  changes(rootId: string): Change[] {
    const batch = this.batches.get(rootId);
    if (!batch) return [];
    return [...batch.changes.values()].sort((a, b) =>
      (this.calls.get(a.toolCallId)?.order ?? 0) - (this.calls.get(b.toolCallId)?.order ?? 0),
    );
  }

  details(rootId: string): DiffDetails | undefined {
    const changes = this.changes(rootId);
    return changes.length ? { version: 1, changes } : undefined;
  }

  watch(rootId: string, invalidate: () => void): void {
    const batch = this.batches.get(rootId);
    if (batch) batch.invalidate = invalidate;
  }

  /** Called after the root result has received its persistent rendering data. */
  end(id: string): void {
    const batch = this.batches.get(id);
    if (!batch) return;
    for (const callId of batch.callIds) this.calls.delete(callId);
    this.batches.delete(id);
  }

  clear(): void {
    this.calls.clear();
    this.batches.clear();
  }

  private redraw(batch: Batch): void {
    try {
      batch.invalidate?.();
    } catch {
      // A detached UI must never turn a successful file mutation into a failure.
    }
  }
}
