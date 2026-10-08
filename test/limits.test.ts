import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Capture } from "../src/capture.ts";
import { DETAILS_KEY, limitChange, readChanges, writeChange, type Change } from "../src/changes.ts";
import {
  MAX_TEXT_BYTES, MAX_TEXT_LINES, MAX_DIFF_BYTES, MAX_DIFF_LINES,
  MAX_BATCH_DIFF_BYTES, MAX_BATCH_DIFF_LINES, lineCount, writeTextFits,
} from "../src/limits.ts";
import { registerWriteCapture } from "../src/write.ts";
import { runtimeFixture } from "./runtime-fixture.ts";

const edit = (id: string, diff: string): Change => ({ toolCallId: id, tool: "edit", path: "a", kind: "edit", diff });

async function writerFixture(t: TestContext) {
  const cwd = await fs.mkdtemp(join(tmpdir(), "pi-codemode-diff-limits-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const capture = new Capture();
  let writer: ToolDefinition<any, any> | undefined;
  registerWriteCapture({ registerTool(tool: ToolDefinition<any, any>) { writer = tool; } } as unknown as ExtensionAPI, capture);
  capture.start("root", "codemode");
  async function write(path: string, content: string) {
    capture.start("root/1", "write", "root");
    return writer!.execute("root/1", { path, content }, undefined, undefined, { cwd } as ExtensionToolContext);
  }
  return { cwd, capture, write };
}

test("input budgets count UTF-8 bytes and logical LF/CRLF/CR lines at their boundaries", () => {
  assert.equal(writeTextFits("x".repeat(MAX_TEXT_BYTES)), true);
  assert.equal(writeTextFits("x".repeat(MAX_TEXT_BYTES + 1)), false);
  assert.equal(writeTextFits("가".repeat(Math.floor(MAX_TEXT_BYTES / 3) + 1)), false);
  for (const ending of ["\n", "\r\n", "\r"]) {
    assert.equal(writeTextFits(("x" + ending).repeat(MAX_TEXT_LINES)), true);
    assert.equal(writeTextFits(("x" + ending).repeat(MAX_TEXT_LINES + 1)), false);
  }
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a\n"), 1);
  assert.equal(lineCount("a\n\n"), 2);
});

test("large old/new write inputs are omitted with sizes, never partial or fake new-file diffs", () => {
  const huge = "x".repeat(MAX_TEXT_BYTES + 1);
  for (const before of [{ kind: "missing" } as const, { kind: "text", content: "old" } as const]) {
    const change = writeChange("root/1", "a", before, huge);
    assert.equal(change.diff, undefined);
    assert.equal(change.kind, before.kind === "missing" ? "create" : "overwrite");
    assert.equal(change.beforeBytes, before.kind === "missing" ? 0 : 3);
    assert.equal(change.afterBytes, MAX_TEXT_BYTES + 1);
    assert.match(change.note!, /Diff omitted: file too large/);
  }
  const old = writeChange("root/1", "a", { kind: "text", content: huge }, "small");
  assert.equal(old.diff, undefined);
  assert.equal(old.beforeBytes, MAX_TEXT_BYTES + 1);
  const many = writeChange("root/1", "a", { kind: "missing" }, "x\r".repeat(MAX_TEXT_LINES + 1));
  assert.equal(many.diff, undefined);
});

test("write diff output has separate byte/line budgets even when inputs fit", () => {
  const exact = writeChange("root/1", "a", { kind: "missing" }, "x".repeat(MAX_DIFF_BYTES - 3));
  assert.equal(Buffer.byteLength(exact.diff!), MAX_DIFF_BYTES);
  const over = writeChange("root/1", "a", { kind: "missing" }, "x".repeat(MAX_DIFF_BYTES - 2));
  assert.equal(over.diff, undefined);
  assert.match(over.note!, /diff too large/);
  assert.equal(over.afterBytes, MAX_DIFF_BYTES - 2);
  const replaced = writeChange("root/1", "a", { kind: "text", content: "old\n".repeat(1_001) }, "new\n".repeat(1_001));
  assert.equal(replaced.diff, undefined);
  assert.match(replaced.note!, /diff too large/);
});

test("edit capture enforces per-diff budgets without changing the supplied result", () => {
  const capture = new Capture();
  capture.start("root", "codemode");
  const oversized = ["x".repeat(MAX_DIFF_BYTES + 1), "+1 x\n".repeat(MAX_DIFF_LINES + 1), "가".repeat(Math.floor(MAX_DIFF_BYTES / 3) + 1)];
  for (let i = 0; i < oversized.length; i++) {
    const id = `root/${i}`;
    capture.start(id, "edit", "root");
    const supplied = edit(id, oversized[i]);
    capture.add(supplied);
    assert.equal(supplied.diff, oversized[i]);
    assert.equal(capture.changes("root")[i].diff, undefined);
    assert.match(capture.changes("root")[i].note!, /diff too large/);
  }
  const exact = edit("exact", "+1 x\n".repeat(MAX_DIFF_LINES));
  assert.strictEqual(limitChange(exact), exact);
});

for (const dimension of ["bytes", "lines"] as const) {
  test(`parent ${dimension} budget is isolated, refunded on replacement, and retains error notices`, () => {
    const capture = new Capture();
    capture.start("root", "codemode");
    capture.start("other", "codemode");
    const diff = dimension === "bytes" ? "x".repeat(MAX_DIFF_BYTES) : "+1 x\n".repeat(MAX_DIFF_LINES);
    for (let i = 0; i < 5; i++) {
      const id = `root/${i}`;
      capture.start(id, "edit", "root");
      capture.add(edit(id, diff));
    }
    assert.equal(capture.changes("root")[4].diff, undefined);
    assert.match(capture.changes("root")[4].note!, /codemode diff budget exceeded/);
    capture.reportError("root/4");
    assert.equal(capture.changes("root")[4].toolReportedError, true);
    capture.start("other/0", "edit", "other");
    capture.add(edit("other/0", diff));
    assert.equal(capture.changes("other")[0].diff, diff);
    capture.add(edit("root/0", ""));
    capture.add(edit("root/4", diff));
    const changes = capture.changes("root");
    assert.equal(changes[4].diff, diff);
    assert.ok(changes.reduce((sum, item) => sum + Buffer.byteLength(item.diff ?? ""), 0) <= MAX_BATCH_DIFF_BYTES);
    assert.ok(changes.reduce((sum, item) => sum + lineCount(item.diff ?? ""), 0) <= MAX_BATCH_DIFF_LINES);
    capture.end("root");
    capture.start("root", "codemode");
    capture.start("root/0", "edit", "root");
    capture.add(edit("root/0", diff));
    assert.equal(capture.changes("root")[0].diff, diff);
  });
}

test("legacy persisted diffs are bounded for rendering without mutating stored data", () => {
  const oversized = edit("root/large", "x".repeat(MAX_DIFF_BYTES + 1));
  const changes = [oversized, ...Array.from({ length: 5 }, (_, i) => edit(`root/${i}`, "x".repeat(MAX_DIFF_BYTES)))];
  const saved = { [DETAILS_KEY]: { version: 1, changes } };
  const read = readChanges(saved)!;
  assert.equal(read[0].diff, undefined);
  assert.equal(read[5].diff, undefined);
  assert.equal(saved[DETAILS_KEY].changes[0].diff, oversized.diff);
  assert.equal(saved[DETAILS_KEY].changes[5].diff!.length, MAX_DIFF_BYTES);
  for (const value of [-1, 1.5, NaN, "1", Infinity]) {
    assert.equal(readChanges({ [DETAILS_KEY]: { version: 1, changes: [{ ...edit("a", ""), beforeBytes: value }] } }), undefined);
  }
});

test("oversized existing files skip snapshot reads and still overwrite successfully", async t => {
  const fixture = await writerFixture(t);
  const file = await fs.open(join(fixture.cwd, "large"), "w");
  await file.truncate(MAX_TEXT_BYTES * 16);
  await file.close();
  const realOpen = fs.open;
  let reads = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", (...readArgs: Parameters<typeof handle.read>) => {
      reads++;
      return read(...readArgs);
    });
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await fixture.write("large", "new");
  assert.equal(reads, 0);
  assert.deepEqual(result.content, [{ type: "text", text: "Successfully wrote to large" }]);
  assert.equal(result.details, undefined);
  assert.equal(await fs.readFile(join(fixture.cwd, "large"), "utf8"), "new");
  const change = fixture.capture.changes("root")[0];
  assert.equal(change.kind, "overwrite");
  assert.equal(change.diff, undefined);
  assert.equal(change.beforeBytes, MAX_TEXT_BYTES * 16);
});

test("snapshot reads remain bounded when the file grows after stat", async t => {
  const fixture = await writerFixture(t);
  const path = join(fixture.cwd, "grow");
  await fs.writeFile(path, "old");
  const realOpen = fs.open;
  let bytesRead = 0;
  let closed = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    const stat = handle.stat.bind(handle);
    const read = handle.read.bind(handle);
    const close = handle.close.bind(handle);
    let first = true;
    t.mock.method(handle, "stat", async () => {
      const value = await stat();
      if (first) {
        first = false;
        await fs.writeFile(path, "x".repeat(MAX_TEXT_BYTES * 2));
      }
      return value;
    });
    t.mock.method(handle, "read", async (...readArgs: Parameters<typeof handle.read>) => {
      const result = await read(...readArgs);
      bytesRead += result.bytesRead;
      return result;
    });
    t.mock.method(handle, "close", async () => { closed = true; await close(); });
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await fixture.write("grow", "new");
  assert.equal(bytesRead, MAX_TEXT_BYTES + 1, JSON.stringify({ closed, changes: fixture.capture.changes("root") }));
  assert.equal(closed, true);
  assert.equal(await fs.readFile(path, "utf8"), "new");
  assert.equal(fixture.capture.changes("root")[0].diff, undefined);
});

test("short snapshot reads reconstruct UTF-8 and old line limits omit the diff", async t => {
  const fixture = await writerFixture(t);
  const original = "이전 😀\r\nsecond\n";
  await fs.writeFile(join(fixture.cwd, "short"), original);
  const realOpen = fs.open;
  let reads = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    const read = handle.read.bind(handle);
    t.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
      reads++;
      return read(buffer, offset, Math.min(length, 2), position);
    });
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await fixture.write("short", "new");
  assert.ok(reads > 1);
  assert.match(fixture.capture.changes("root")[0].diff!, /이전 😀/);
  t.mock.restoreAll();
  syncBuiltinESMExports();
  await fs.writeFile(join(fixture.cwd, "lines"), "x\r\n".repeat(MAX_TEXT_LINES + 1));
  await fixture.write("lines", "new");
  const change = fixture.capture.changes("root")[0];
  assert.equal(change.kind, "overwrite");
  assert.equal(change.diff, undefined);
  assert.equal(change.beforeBytes, (MAX_TEXT_LINES + 1) * 3);
  assert.equal(await fs.readFile(join(fixture.cwd, "lines"), "utf8"), "new");
});

test("large new content skips reading a small old snapshot and preserves exact written bytes", async t => {
  const fixture = await writerFixture(t);
  await fs.writeFile(join(fixture.cwd, "a"), "old");
  const realOpen = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    t.mock.method(handle, "read", () => { throw new Error("Snapshot must not be read"); });
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const content = "가".repeat(Math.floor(MAX_TEXT_BYTES / 3) + 1);
  await fixture.write("a", content);
  assert.equal(await fs.readFile(join(fixture.cwd, "a"), "utf8"), content);
  const change = fixture.capture.changes("root")[0];
  assert.equal(change.kind, "overwrite");
  assert.equal(change.beforeBytes, 3);
  assert.equal(change.afterBytes, Buffer.byteLength(content));
  assert.match(change.note!, /file too large/);
});

test("real Pi shares the parent storage budget between writes and edits", { timeout: 30_000 }, async t => {
  const fixture = await runtimeFixture(t);
  await fs.writeFile(join(fixture.cwd, "edit"), "old");
  const result = await fixture.codemode(`
    for (let i = 0; i < 5; i++) {
      await tools.write({path: "file-" + i, content: "x".repeat(${MAX_DIFF_BYTES - 3})});
    }
    await tools.edit({path: "edit", edits: [{oldText: "old", newText: "new"}]});
  `);
  assert.equal(result.isError, false);
  const changes = readChanges(result.details)!;
  assert.equal(changes.length, 6);
  assert.equal(changes.reduce((sum, change) => sum + Buffer.byteLength(change.diff ?? ""), 0), MAX_BATCH_DIFF_BYTES);
  assert.ok(changes.slice(4).every(change => change.diff === undefined && /codemode diff budget exceeded/.test(change.note!)));
  assert.equal(await fs.readFile(join(fixture.cwd, "file-4"), "utf8"), "x".repeat(MAX_DIFF_BYTES - 3));
  assert.equal(await fs.readFile(join(fixture.cwd, "edit"), "utf8"), "new");
});

test("real Pi persists omission notices for large writes and edits without changing tool outcomes", { timeout: 30_000 }, async t => {
  const fixture = await runtimeFixture(t);
  await fs.writeFile(join(fixture.cwd, "large-old"), "x".repeat(MAX_TEXT_BYTES + 1));
  await fs.writeFile(join(fixture.cwd, "edit"), "a".repeat(MAX_DIFF_BYTES));
  const result = await fixture.codemode(`
    text(await tools.write({path: "large-old", content: "small"}));
    text(await tools.write({path: "large-new", content: "가".repeat(${MAX_TEXT_BYTES})}));
    text(await tools.edit({path: "edit", edits: [{oldText: "a".repeat(${MAX_DIFF_BYTES}), newText: "b".repeat(${MAX_DIFF_BYTES})}]}));
    await tools.write({path: "normal", content: "visible"});
  `);
  assert.equal(result.isError, false);
  const changes = readChanges(result.details)!;
  assert.equal(changes.length, 4);
  assert.ok(changes.slice(0, 3).every(change => change.diff === undefined && /Diff omitted/.test(change.note!)));
  assert.match(changes[3].diff!, /visible/);
  assert.match(JSON.stringify(result.content), /Successfully wrote/);
  assert.match(JSON.stringify(result.content), /Successfully replaced/);
  assert.doesNotMatch(JSON.stringify(result.content), /Diff omitted|piCodemodeDiff/);
  assert.ok(JSON.stringify(result.details).length < 8_000);
  assert.equal(await fs.readFile(join(fixture.cwd, "large-old"), "utf8"), "small");
  assert.equal(await fs.readFile(join(fixture.cwd, "large-new"), "utf8"), "가".repeat(MAX_TEXT_BYTES));
  assert.equal(await fs.readFile(join(fixture.cwd, "edit"), "utf8"), "b".repeat(MAX_DIFF_BYTES));
  const resumed = await fixture.resume();
  const restored = resumed.messages.find(message => message.role === "toolResult" && message.toolCallId === "root");
  assert.ok(restored && restored.role === "toolResult");
  assert.deepEqual(readChanges(restored.details), changes);
});
