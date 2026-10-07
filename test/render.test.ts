import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { Capture } from "../src/capture.ts";
import { DETAILS_KEY, type Change } from "../src/changes.ts";
import { diffSection, PREVIEW_CHANGES, PREVIEW_LINES, registerDiffRenderer } from "../src/render.ts";

const theme = {
  fg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => `\u001b[7m${text}\u001b[27m`,
} as unknown as Theme;

function change(id: string, diff = Array.from({ length: 30 }, (_, i) => `+${i + 1} line-${i + 1}`).join("\n")): Change {
  return { toolCallId: id, tool: "edit", path: `${id}.ts`, kind: "edit", diff };
}

function text(component: Component, width = 80): string {
  return component.render(width).join("\n");
}

test("collapsed previews are bounded; full view retains all changes and lines", () => {
  const changes = Array.from({ length: PREVIEW_CHANGES + 2 }, (_, i) => change(`call-${i}`));
  const preview = text(diffSection(changes, false, theme));
  assert.match(preview, /more lines/);
  assert.match(preview, /2 more changes/);
  assert.equal(preview.includes("line-30"), false);
  assert.equal(preview.includes("call-4.ts"), false);
  const full = text(diffSection(changes, true, theme));
  assert.match(full, /line-30/);
  assert.match(full, /call-4.ts/);
  assert.equal(full.includes("more lines"), false);
});

test("truncation uses wrapped visual lines, not just logical line count", () => {
  const preview = diffSection([change("a", "+1 " + "x".repeat(1000))], false, theme);
  const narrow = preview.render(20);
  assert.ok(narrow.every(line => visibleWidth(line) <= 20));
  assert.ok(narrow.length <= PREVIEW_LINES + 6);
  assert.match(narrow.join("\n"), /more lines/);
  assert.ok(text(diffSection([change("a", "+1 " + "x".repeat(1000))], true, theme), 20).length > 1000);
});

test("file paths and file contents cannot inject terminal controls", () => {
  const malicious: Change = { ...change("a", "+1 \u001b[2Jsecret"), path: "a\n\u001b[2J.ts" };
  const rendered = text(diffSection([malicious], true, theme));
  assert.equal(rendered.includes("\u001b"), false);
  assert.match(rendered, /a\\n/);
});

test("edit and write replacements highlight words in preview and full view without mutating metadata", () => {
  for (const tool of ["edit", "write"] as const) {
    const item: Change = { ...change("a", "-1 const timeout = 1000;\n+1 const timeout = 5000;"), tool, kind: tool === "edit" ? "edit" : "overwrite" };
    const saved = JSON.stringify(item);
    for (const expanded of [false, true]) {
      const output = text(diffSection([item], expanded, theme));
      assert.ok(output.includes(theme.inverse("1000")));
      assert.ok(output.includes(theme.inverse("5000")));
      assert.equal(JSON.stringify(item), saved, "Styling must not enter persisted metadata");
    }
  }
});

test("replacements reducing repeated spaces preserve each line's original spacing", () => {
  const item = change("a", "-1 const  timeout = 1000;\n+1 const timeout = 1000;");
  for (const expanded of [false, true]) {
    const output = text(diffSection([item], expanded, theme));
    assert.match(output, /-1 const  timeout = 1000;/);
    assert.match(output, /\+1 const timeout = 1000;/);
  }
});

test("word highlighting only introduces trusted ANSI after sanitizing file content", () => {
  const item = change("a", "-1 \told\u001b[2J\u009b2J\n+1 \tnew\u001b[2J\u009b2J");
  const output = text(diffSection([item], true, theme));
  assert.ok(output.includes(theme.inverse("old")));
  assert.ok(output.includes(theme.inverse("new")));
  assert.equal(output.includes("\u001b[2J"), false);
  assert.equal(output.includes("\u009b"), false);
  assert.equal(output.includes("\t"), false);
});

test("highlighted Unicode replacements wrap within resized widths and retain full content", () => {
  const before = "before ".repeat(80) + "이전 😀";
  const after = "before ".repeat(80) + "이후 🚀";
  const item = change("a", `-1 ${before}\n+1 ${after}`);
  for (const expanded of [false, true]) {
    const section = diffSection([item], expanded, theme);
    for (const width of [16, 40, 80, 16]) {
      section.invalidate();
      const lines = section.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      if (expanded) assert.ok(lines.join("\n").includes("\u001b[7m"));
      else assert.match(lines.join("\n"), /more/);
    }
  }
});

test("original result rendering is preserved and gets its own previous component", () => {
  let resolver: Parameters<ExtensionAPI["registerToolRenderer"]>[0] | undefined;
  const capture = new Capture();
  registerDiffRenderer({
    registerToolRenderer(value: Parameters<ExtensionAPI["registerToolRenderer"]>[0]) { resolver = value; },
  } as unknown as ExtensionAPI, capture);

  const seenPrevious: Array<Component | undefined> = [];
  const base: ToolRenderers = {
    renderResult(_result, _options, _theme, context) {
      seenPrevious.push(context.lastComponent);
      const original = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      original.setText("ORIGINAL OUTPUT");
      return original;
    },
  };
  const wrapped = resolver!("codemode", () => base)!;
  const render = wrapped.renderResult!;
  const result = { content: [{ type: "text" as const, text: "model output" }], details: { calls: [], [DETAILS_KEY]: { version: 1, changes: [change("a")] } } };
  type Context = Parameters<typeof render>[3];
  const context: Context = {
    args: { code: "..." }, toolCallId: "root", invalidate() {}, lastComponent: undefined,
    state: {}, cwd: "/tmp", executionStarted: true, argsComplete: true, isPartial: false,
    expanded: false, showImages: true, isError: false,
  };
  const preview = render(result, { expanded: false, isPartial: false }, theme, context);
  assert.match(text(preview), /ORIGINAL OUTPUT/);
  const full = render(result, { expanded: true, isPartial: false }, theme, { ...context, expanded: true, lastComponent: preview });
  assert.strictEqual(full, preview);
  assert.match(text(full), /line-30/);
  assert.equal(seenPrevious[0], undefined);
  assert.ok(seenPrevious[1] instanceof Text);
  assert.notStrictEqual(seenPrevious[1], preview);
  full.invalidate();
  const collapsed = render(result, { expanded: false, isPartial: false }, theme, { ...context, lastComponent: full });
  assert.equal(text(collapsed).includes("line-30"), false);
});

test("live partial results redraw and final persisted details work after cleanup", () => {
  let resolver: Parameters<ExtensionAPI["registerToolRenderer"]>[0] | undefined;
  const capture = new Capture();
  registerDiffRenderer({ registerToolRenderer(value: typeof resolver) { resolver = value; } } as unknown as ExtensionAPI, capture);
  const render = resolver!("codemode", () => ({ renderResult: () => new Text("running", 0, 0) }))!.renderResult!;
  let invalidated = 0;
  capture.start("root", "codemode");
  capture.start("root/1", "edit", "root");
  const context: Parameters<typeof render>[3] = {
    args: {}, toolCallId: "root", invalidate() { invalidated++; }, lastComponent: undefined,
    state: {}, cwd: "/tmp", executionStarted: true, argsComplete: true, isPartial: true,
    expanded: false, showImages: true, isError: false,
  };
  render({ content: [], details: {} }, { expanded: false, isPartial: true }, theme, context);
  capture.add(change("root/1"));
  assert.equal(invalidated, 1);
  const partial = render({ content: [], details: {} }, { expanded: false, isPartial: true }, theme, context);
  assert.match(text(partial), /File changes/);
  const saved = JSON.parse(JSON.stringify(capture.details("root")));
  capture.end("root");
  const resumed = render({ content: [], details: { [DETAILS_KEY]: saved } }, { expanded: true, isPartial: false }, theme, { ...context, isPartial: false, expanded: true });
  assert.match(text(resumed), /line-30/);
});

test("unavailable diffs show their notice without misleading zero-change counts", () => {
  const rendered = text(diffSection([{
    toolCallId: "a", tool: "write", path: "binary", kind: "unknown", note: "Text diff unavailable.",
  }], false, theme));
  assert.match(rendered, /Text diff unavailable/);
  assert.equal(rendered.includes("+0"), false);
  assert.equal(rendered.includes("-0"), false);
});

test("post-mutation errors remain visible even when the diff is collapsed", () => {
  const rendered = text(diffSection([{ ...change("a"), toolReportedError: true }], false, theme));
  assert.match(rendered, /File change observed/);
  assert.match(rendered, /error or cancellation/);
});

test("Unicode, emoji, and tabs fit narrow widths after resize and invalidation", () => {
  const section = diffSection([change("unicode", "+1 한글 😀\t".repeat(80))], false, theme);
  for (const width of [16, 40, 80, 16]) {
    section.invalidate();
    const lines = section.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `All lines must fit ${width} columns`);
    assert.ok(lines.length < 30, "The wrapped preview must remain bounded");
  }
});

test("Pi does not invent a renderer for marker-like or missing downstream renderers", () => {
  let resolver: Parameters<ExtensionAPI["registerToolRenderer"]>[0] | undefined;
  registerDiffRenderer({ registerToolRenderer(value: typeof resolver) { resolver = value; } } as unknown as ExtensionAPI, new Capture());
  const marker: ToolRenderers = { renderShell: "self" };
  assert.strictEqual(resolver!("codemode", () => marker), marker);
  assert.equal(resolver!("codemode", () => undefined), undefined);
});

test("renderer composition keeps the original call renderer and shell", () => {
  let resolver: Parameters<ExtensionAPI["registerToolRenderer"]>[0] | undefined;
  registerDiffRenderer({ registerToolRenderer(value: typeof resolver) { resolver = value; } } as unknown as ExtensionAPI, new Capture());
  const base: ToolRenderers = {
    renderShell: "self", renderCall: () => new Text("original call", 0, 0), renderResult: () => new Text("original result", 0, 0),
  };
  const wrapped = resolver!("codemode", () => base)!;
  assert.strictEqual(wrapped.renderCall, base.renderCall);
  assert.equal(wrapped.renderShell, "self");
});
