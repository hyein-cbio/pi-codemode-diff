import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";
import { initTheme, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
// Test-only access to the same active theme used by Pi's native renderer.
import { theme as currentTheme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { coloredDiff } from "../src/diff.ts";

const inverse = (value: string) => `\u001b[7m${value}\u001b[27m`;
const theme = {
  fg: (_token: string, value: string) => value,
  inverse,
} as unknown as Theme;

test("only changed words get inverse video; prefixes and unchanged text do not", () => {
  const input = " 3 context\n-4 const timeout = 1000;\n+4 const timeout = 5000;";
  const output = coloredDiff(input, theme);
  assert.equal(output, ` 3 context\n-4 const timeout = ${inverse("1000")};\n+4 const timeout = ${inverse("5000")};`);
  assert.equal(stripVTControlCharacters(output), input);
});

test("word highlighting matches native Pi edit for both built-in themes", (t) => {
  const level = chalk.level;
  chalk.level = 3;
  t.after(() => { chalk.level = level; });
  const samples = [
    "-1 const timeout = 1000;\n+1 const timeout = 5000;",
    "-1   old(value);\n+1   new(value);",
    "-1 foo();\n+1 foo(bar);",
    "-1 foo(bar);\n+1 foo();",
    "-1 old\n+1 new",
    "-1 \n+1 new",
    "-1 old\n+1 ",
    "-1 first = 1; last = 2;\n+1 first = 3; last = 4;",
    "-1 이름 = '이전 😀';\n+1 이름 = '이후 🚀';",
    "-1 same content\n+1 same content",
    " 1 context\n-2 one\n-3 two\n+2 three\n+3 four\n     ...",
    "- 9 before\n+ 9 after\n 10 context",
  ];
  for (const name of ["dark", "light"]) {
    initTheme(name, false);
    for (const sample of samples) {
      assert.equal(coloredDiff(sample, currentTheme), renderDiff(sample), `${name}: ${sample}`);
    }
  }
});

test("standalone changes, multi-line blocks, and malformed diff lines keep line colors", () => {
  for (const input of [
    "+1 addition", "-1 deletion", "-1 a\n-2 b\n+1 c", "-1 a\n+1 b\n+2 c",
    "-1 a\n 2 context\n+3 b", "-1 a\n     ...\n+9 b", "--- a/file\n+++ b/file",
  ]) {
    assert.equal(coloredDiff(input, theme), input);
  }
});

test("indentation is not highlighted, and multiple single-line hunks are independent", () => {
  const input = "-1     before\n+1     after\n 2 context\n-3 old\n+3 new";
  assert.equal(coloredDiff(input, theme), `-1     ${inverse("before")}\n+1     ${inverse("after")}\n 2 context\n-3 ${inverse("old")}\n+3 ${inverse("new")}`);
});

test("the supplied theme controls line colors and changed-word styling", () => {
  const suppliedTheme = {
    fg: (token: string, value: string) => `<${token}>${value}</${token}>`,
    inverse: (value: string) => `<changed>${value}</changed>`,
  } as unknown as Theme;
  assert.equal(coloredDiff("-1 old\n+1 new", suppliedTheme),
    "<toolDiffRemoved>-1 <changed>old</changed></toolDiffRemoved>\n<toolDiffAdded>+1 <changed>new</changed></toolDiffAdded>");
});

test("spacing changes preserve both original lines instead of normalizing shared whitespace", () => {
  for (const input of [
    "-1 const  timeout = 1000;\n+1 const timeout = 1000;",
    "-1 const  timeout = 1000;\n+1 const timeout = 5000;",
    "-1   same content\n+1 same content",
    "-1 same content  \n+1 same content",
  ]) {
    assert.equal(stripVTControlCharacters(coloredDiff(input, theme)), input);
  }
});

test("oversized or high-edit-distance comparisons fall back without dropping text", () => {
  const inputs = [
    `-1 ${"a".repeat(20_001)}\n+1 ${"b".repeat(20_001)}`,
    `-1 ${Array.from({ length: 600 }, (_, i) => `old${i}`).join(" ")}\n+1 ${Array.from({ length: 600 }, (_, i) => `new${i}`).join(" ")}`,
  ];
  for (const input of inputs) assert.equal(coloredDiff(input, theme), input);
});
