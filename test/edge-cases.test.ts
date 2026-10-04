import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Capture } from "../src/capture.ts";
import { DETAILS_KEY, readChanges, writeChange } from "../src/changes.ts";
import { registerWriteCapture } from "../src/write.ts";

async function writerFixture(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-codemode-diff-edge-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const capture = new Capture();
  let writer: ToolDefinition<any, any> | undefined;
  registerWriteCapture({ registerTool(tool: ToolDefinition<any, any>) { writer = tool; } } as unknown as ExtensionAPI, capture);
  capture.start("root", "codemode");
  async function write(id: string, path: string, content: string, signal?: AbortSignal) {
    capture.start(id, "write", "root");
    return writer!.execute(id, { path, content }, signal, undefined, { cwd } as ExtensionToolContext);
  }
  return { cwd, capture, write };
}

test("persisted metadata rejects non-string kinds and incorrectly typed optional fields", () => {
  const valid = { toolCallId: "a/1", tool: "edit", path: "a", kind: "edit", diff: "+1 a" };
  for (const invalid of [
    { ...valid, kind: ["edit"] },
    { ...valid, kind: null },
    { ...valid, diff: 1 },
    { ...valid, note: [] },
    { ...valid, toolReportedError: "true" },
    { ...valid, path: null },
  ]) {
    assert.equal(readChanges({ [DETAILS_KEY]: { version: 1, changes: [invalid] } }), undefined);
  }
});

test("permission-denied snapshots do not block an otherwise writable file", async t => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("POSIX read/write permissions require a non-root user");
    return;
  }
  const fixture = await writerFixture(t);
  const path = join(fixture.cwd, "write-only");
  await writeFile(path, "old");
  await chmod(path, 0o200);
  try {
    await fixture.write("root/1", "write-only", "new");
  } finally {
    await chmod(path, 0o600);
  }
  assert.equal(await readFile(path, "utf8"), "new");
  const change = fixture.capture.changes("root")[0];
  assert.equal(change.kind, "unknown");
  assert.equal(change.diff, undefined);
  assert.match(change.note!, /could not be read/);
});

test("actual filesystem write failures do not create a captured success", async t => {
  const fixture = await writerFixture(t);
  await mkdir(join(fixture.cwd, "directory"));
  await assert.rejects(fixture.write("root/1", "directory", "cannot replace a directory"));
  assert.deepEqual(fixture.capture.changes("root"), []);
});

test("creating an empty file still creates a visible change", async t => {
  const fixture = await writerFixture(t);
  await fixture.write("root/1", "empty", "");
  assert.equal((await readFile(join(fixture.cwd, "empty"))).length, 0);
  assert.equal(fixture.capture.changes("root")[0].note, "Created an empty file.");
});

test("a cancellation observed after the write does not erase its captured mutation", async t => {
  const fixture = await writerFixture(t);
  const controller = new AbortController();
  fixture.capture.watch("root", () => controller.abort());
  await assert.rejects(fixture.write("root/1", "applied", "written", controller.signal), /aborted/i);
  assert.equal(await readFile(join(fixture.cwd, "applied"), "utf8"), "written");
  assert.equal(fixture.capture.changes("root").length, 1);
});

test("binary new content is written without inventing a text diff", async t => {
  const fixture = await writerFixture(t);
  await fixture.write("root/1", "binary", "a\0b");
  assert.deepEqual(await readFile(join(fixture.cwd, "binary")), Buffer.from("a\0b"));
  const change = fixture.capture.changes("root")[0];
  assert.equal(change.kind, "create");
  assert.equal(change.diff, undefined);
  assert.match(change.note!, /Binary/);
});

test("display normalization never changes the bytes written to the file", async t => {
  const fixture = await writerFixture(t);
  await writeFile(join(fixture.cwd, "a"), "same\n");
  const content = "\uFEFFsame\r\n";
  await fixture.write("root/1", "a", content);
  assert.deepEqual(await readFile(join(fixture.cwd, "a")), Buffer.from(content));
  const change = fixture.capture.changes("root")[0];
  assert.equal(change.diff, "");
  assert.match(change.note!, /line endings.*BOM/);
});

test("a missing final newline is not mislabeled as an unchanged write", () => {
  const change = writeChange("root/1", "a", { kind: "text", content: "same\n" }, "same");
  assert.notEqual(change.diff, "");
  assert.notEqual(change.note, "No content changes.");
});

test("writes through a symlink and its target share the native mutation queue", async t => {
  if (process.platform === "win32") {
    t.skip("Creating symlinks may require elevated privileges on Windows");
    return;
  }
  const fixture = await writerFixture(t);
  await writeFile(join(fixture.cwd, "target"), "zero\n");
  await symlink("target", join(fixture.cwd, "alias"));
  await Promise.all([
    fixture.write("root/1", "alias", "one\n"),
    fixture.write("root/2", "target", "two\n"),
  ]);
  const changes = fixture.capture.changes("root");
  assert.match(changes[0].diff!, /zero/);
  assert.match(changes[1].diff!, /one/);
  assert.equal(await readFile(join(fixture.cwd, "target"), "utf8"), "two\n");
});
