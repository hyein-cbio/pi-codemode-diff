import assert from "node:assert/strict";
import { test } from "node:test";
import { Capture } from "../src/capture.ts";
import { countChanges, DETAILS_KEY, readChanges, writeChange, type Change } from "../src/changes.ts";

const edit = (id: string, path = "a.ts"): Change => ({
  toolCallId: id, tool: "edit", path, kind: "edit", diff: "-1 before\n+1 after",
});

test("captures descendants only and isolates parallel codemode calls", () => {
  const capture = new Capture();
  capture.start("direct", "edit");
  capture.add(edit("direct"));
  assert.equal(capture.rootFor("direct"), undefined);
  capture.start("a", "codemode");
  capture.start("b", "codemode");
  capture.start("a/1", "helper", "a");
  capture.start("a/1/1", "edit", "a/1");
  capture.start("b/1", "edit", "b");
  capture.add(edit("a/1/1"));
  capture.add(edit("b/1", "b.ts"));
  assert.deepEqual(capture.changes("a").map(c => c.path), ["a.ts"]);
  assert.deepEqual(capture.changes("b").map(c => c.path), ["b.ts"]);
});

test("orders parallel completions by call start and replaces rather than duplicates", () => {
  const capture = new Capture();
  capture.start("a", "codemode");
  capture.start("a/1", "edit", "a");
  capture.start("a/2", "edit", "a");
  capture.add(edit("a/2"));
  capture.add(edit("a/1"));
  capture.add(edit("a/2", "updated.ts"));
  assert.deepEqual(capture.changes("a").map(c => c.toolCallId), ["a/1", "a/2"]);
  assert.equal(capture.changes("a")[1].path, "updated.ts");
});

test("only root completion clears descendants; saved details remain valid", () => {
  const capture = new Capture();
  capture.start("a", "codemode");
  capture.start("a/1", "edit", "a");
  capture.add(edit("a/1"));
  const saved = capture.details("a");
  capture.end("a/1");
  assert.equal(capture.changes("a").length, 1);
  capture.end("a");
  assert.equal(capture.rootFor("a/1"), undefined);
  assert.equal(capture.changes("a").length, 0);
  assert.equal(readChanges({ [DETAILS_KEY]: JSON.parse(JSON.stringify(saved)) })?.length, 1);
});

test("UI invalidation failures do not prevent capture", () => {
  const capture = new Capture();
  capture.start("a", "codemode");
  capture.start("a/1", "write", "a");
  capture.watch("a", () => { throw new Error("detached UI"); });
  capture.add({ ...edit("a/1"), tool: "write", kind: "overwrite" });
  capture.reportError("a/1");
  assert.equal(capture.changes("a")[0].toolReportedError, true);
  capture.clear();
  assert.equal(capture.details("a"), undefined);
});

test("creates an all-added diff and treats empty creation as a real change", () => {
  const change = writeChange("a/1", "new.ts", { kind: "missing" }, "one\ntwo\n");
  assert.equal(change.kind, "create");
  assert.deepEqual(countChanges(change.diff!), { added: 2, removed: 0 });
  assert.match(writeChange("a/2", "empty", { kind: "missing" }, "").note!, /empty file/);
});

test("overwrites use actual previous content, including unchanged writes", () => {
  const change = writeChange("a/1", "a", { kind: "text", content: "before\n" }, "after\n");
  assert.deepEqual(countChanges(change.diff!), { added: 1, removed: 1 });
  assert.equal(change.kind, "overwrite");
  const same = writeChange("a/2", "a", { kind: "text", content: "same\n" }, "same\n");
  assert.equal(same.diff, "");
  assert.equal(same.note, "No content changes.");
});

test("CRLF/BOM-only changes are explicit, not fake content changes", () => {
  const change = writeChange("a/1", "a", { kind: "text", content: "\uFEFFsame\r\n" }, "same\n");
  assert.equal(change.diff, "");
  assert.match(change.note!, /line endings.*BOM/);
});

test("unavailable/binary snapshots do not masquerade as new files", () => {
  const unavailable = writeChange("a/1", "a", { kind: "unavailable", reason: "Unreadable" }, "after");
  assert.equal(unavailable.kind, "unknown");
  assert.equal(unavailable.diff, undefined);
  assert.equal(unavailable.note, "Unreadable");
  assert.match(writeChange("a/2", "a", { kind: "missing" }, "\0binary").note!, /Binary/);
});

test("rejects malformed persisted metadata and patch headers in counts", () => {
  assert.equal(readChanges(undefined), undefined);
  assert.equal(readChanges({ [DETAILS_KEY]: { version: 2, changes: [] } }), undefined);
  assert.equal(readChanges({ [DETAILS_KEY]: { version: 1, changes: [{ tool: "write" }] } }), undefined);
  assert.deepEqual(countChanges("--- a\n+++ b\n-1 old\n+1 new\n 2 context"), { added: 1, removed: 1 });
});
