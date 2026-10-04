import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { fauxAssistantMessage, Type } from "@earendil-works/pi-ai";
import { DETAILS_KEY, readChanges } from "../src/changes.ts";
import { runtimeFixture } from "./runtime-fixture.ts";

const options = { timeout: 30_000 };

test("real Pi loads the extension and captures sandbox edit/write without changing result text", options, async t => {
  const fixture = await runtimeFixture(t);
  const result = await fixture.codemode(`
    text(await tools.write({ path: "a.txt", content: "before\\n" }));
    text(await tools.edit({ path: "a.txt", edits: [{ oldText: "before", newText: "after" }] }));
  `, "root", context => {
    const parent = context.messages.find(message => message.role === "toolResult" && message.toolCallId === "root");
    assert.ok(parent && parent.role === "toolResult");
    // Inspect model-facing text, not the session-only metadata on the message object.
    const output = JSON.stringify(parent.content);
    assert.match(output, /Successfully wrote/);
    assert.match(output, /Successfully replaced/);
    assert.equal(output.includes(DETAILS_KEY), false);
    assert.equal(output.includes("+1 after"), false);
    return fauxAssistantMessage("Done.");
  });
  assert.equal(result.isError, false);
  const changes = readChanges(result.details)!;
  assert.deepEqual(changes.map(change => change.tool), ["write", "edit"]);
  assert.match(changes[1].diff!, /-1 before\n\+1 after/);
  assert.equal(await readFile(join(fixture.cwd, "a.txt"), "utf8"), "after\n");
  assert.equal(fixture.session.messages.filter(message => message.role === "toolResult").length, 1, "Nested results must not become extra model tool messages");
});

test("real Pi direct edit/write preserve native metadata and do not acquire codemode diffs", options, async t => {
  const fixture = await runtimeFixture(t);
  await writeFile(join(fixture.cwd, "edit.txt"), "before\n");
  const results = await fixture.run([
    { id: "direct-edit", name: "edit", arguments: { path: "edit.txt", edits: [{ oldText: "before", newText: "after" }] } },
    { id: "direct-write", name: "write", arguments: { path: "write.txt", content: "hello\n" } },
  ]);
  assert.ok(results.every(result => !result.isError && readChanges(result.details) === undefined));
  assert.match((results.find(result => result.toolName === "edit")!.details as { diff: string }).diff, /before/);
  assert.equal(results.find(result => result.toolName === "write")!.details, undefined);
  assert.equal(await readFile(join(fixture.cwd, "edit.txt"), "utf8"), "after\n");
});

test("real Pi keeps disabled write unreachable from codemode", options, async t => {
  const fixture = await runtimeFixture(t, { tools: ["read", "codemode"] });
  assert.deepEqual(new Set(fixture.session.getActiveToolNames()), new Set(["read", "codemode"]));
  const result = await fixture.codemode('await tools.write({path: "must-not-exist", content: "bad"});');
  assert.equal(result.isError, true);
  assert.equal(readChanges(result.details), undefined);
  await assert.rejects(access(join(fixture.cwd, "must-not-exist")), { code: "ENOENT" });
});

test("real Pi --no-tools selection does not reactivate the wrapped writer", options, async t => {
  const fixture = await runtimeFixture(t, { noTools: "all" });
  assert.deepEqual(fixture.session.getActiveToolNames(), []);
});

test("real Pi captures a helper tool's nested write under its codemode ancestor", options, async t => {
  const fixture = await runtimeFixture(t, { tools: ["read", "edit", "write", "codemode", "helper"], extraExtensions: [pi => {
    pi.registerTool({
      name: "helper", label: "helper", description: "Local test helper", exposure: "codemode",
      parameters: Type.Object({}),
      async execute(_id, _input, signal, _update, ctx) {
        const outcome = await ctx.executeTool("write", { path: "helper.txt", content: "nested\n" }, { signal });
        return outcome.result;
      },
    });
  }] });
  const result = await fixture.codemode('text(await tools.helper({}));');
  assert.equal(result.isError, false, JSON.stringify(result.content));
  const changes = readChanges(result.details)!;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].toolCallId, "root/1/1");
  assert.equal(changes[0].path, "helper.txt");
});

test("real Pi separates concurrently issued codemode calls", options, async t => {
  const fixture = await runtimeFixture(t);
  const results = await fixture.run([
    { id: "left", name: "codemode", arguments: { code: 'await tools.write({path: "left.txt", content: "left"});' } },
    { id: "right", name: "codemode", arguments: { code: 'await tools.write({path: "right.txt", content: "right"});' } },
  ]);
  for (const result of results) {
    assert.equal(result.isError, false);
    assert.deepEqual(readChanges(result.details)?.map(change => change.path), [`${result.toolCallId}.txt`]);
  }
});

test("real Pi preserves completed writes when the enclosing script throws", options, async t => {
  const fixture = await runtimeFixture(t);
  const result = await fixture.codemode('await tools.write({path: "written.txt", content: "kept"}); throw new Error("test failure");');
  assert.equal(result.isError, true);
  assert.equal(readChanges(result.details)?.length, 1);
  assert.equal(await readFile(join(fixture.cwd, "written.txt"), "utf8"), "kept");
});

test("real Pi blocked writes neither mutate files nor generate success diffs", options, async t => {
  const fixture = await runtimeFixture(t, { extraExtensions: [pi => {
    pi.on("tool_call", event => event.toolName === "write" ? { block: true, reason: "Denied by test policy" } : undefined);
  }] });
  const result = await fixture.codemode('await tools.write({path: "denied.txt", content: "bad"});');
  assert.equal(result.isError, true);
  assert.equal(readChanges(result.details), undefined);
  await assert.rejects(access(join(fixture.cwd, "denied.txt")), { code: "ENOENT" });
});

test("real Pi records the final error status when another result handler rejects a completed write", options, async t => {
  const fixture = await runtimeFixture(t, { extraExtensions: [pi => {
    pi.on("tool_result", event => event.toolName === "write" ? { isError: true } : undefined);
  }] });
  const result = await fixture.codemode('await tools.write({path: "applied.txt", content: "written"});');
  assert.equal(result.isError, true);
  assert.equal(await readFile(join(fixture.cwd, "applied.txt"), "utf8"), "written");
  assert.equal(readChanges(result.details)?.[0].toolReportedError, true);
});

test("real session persistence and resume retain full diff metadata", options, async t => {
  const fixture = await runtimeFixture(t);
  const result = await fixture.codemode('await tools.write({path: "persisted.txt", content: "saved\\n"});');
  const original = readChanges(result.details);
  assert.ok(original?.length);
  const resumed = await fixture.resume();
  const restored = resumed.messages.find(message => message.role === "toolResult" && message.toolCallId === "root");
  assert.ok(restored && restored.role === "toolResult");
  assert.deepEqual(readChanges(restored.details), original);
  await fixture.codemode('text(await tools.read({path: "persisted.txt"}));', "read-only");
  const oldResult = fixture.session.messages.find(message => message.role === "toolResult" && message.toolCallId === "root");
  assert.ok(oldResult && oldResult.role === "toolResult");
  assert.deepEqual(readChanges(oldResult.details), original);
});

test("real extension reload preserves old diffs and instruments subsequent calls", options, async t => {
  const fixture = await runtimeFixture(t);
  const first = await fixture.codemode('await tools.write({path: "a", content: "one"});', "first");
  await fixture.session.reload();
  const old = fixture.session.messages.find(message => message.role === "toolResult" && message.toolCallId === "first");
  assert.ok(old && old.role === "toolResult");
  assert.deepEqual(readChanges(old.details), readChanges(first.details));
  const next = await fixture.codemode('await tools.write({path: "a", content: "two"});', "second");
  assert.equal(next.isError, false);
  assert.match(readChanges(next.details)![0].diff!, /one/);
  assert.match(readChanges(next.details)![0].diff!, /two/);
});

test("a real failed edit does not change the file or produce a success diff", options, async t => {
  const fixture = await runtimeFixture(t);
  await writeFile(join(fixture.cwd, "a"), "original");
  const result = await fixture.codemode('await tools.edit({path: "a", edits: [{oldText: "not present", newText: "bad"}]});');
  assert.equal(result.isError, true);
  assert.equal(readChanges(result.details), undefined);
  assert.equal(await readFile(join(fixture.cwd, "a"), "utf8"), "original");
});

test("Pi's actual tool component composes native codemode output with expandable diffs", options, async t => {
  const fixture = await runtimeFixture(t);
  const code = 'await tools.write({path: "many.txt", content: Array.from({length: 30}, (_, i) => "marker-" + (i + 1)).join("\\n")});';
  const result = await fixture.codemode(code);
  const native = fixture.session.getToolDefinition("codemode");
  assert.ok(native);
  const renderers = fixture.session.extensionRunner.resolveToolRenderers("codemode", () => native);
  assert.ok(renderers);
  initTheme("dark", false);
  const component = new ToolExecutionComponent("codemode", "root", { code }, {}, { ...native, ...renderers }, { requestRender() {} } as TUI, fixture.cwd);
  component.setArgsComplete();
  component.updateResult(result);
  const visible = () => stripVTControlCharacters(component.render(80).join("\n"));
  assert.match(visible(), /File changes/);
  assert.match(visible(), /many.txt/);
  assert.equal(visible().includes("marker-30"), false);
  component.setExpanded(true);
  assert.match(visible(), /marker-30/);
  initTheme("light", false);
  component.invalidate();
  assert.match(visible(), /marker-30/);
  component.setExpanded(false);
  assert.equal(visible().includes("marker-30"), false);
});
