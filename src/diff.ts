import { diffWords } from "diff";
import type { Theme } from "@earendil-works/pi-coding-agent";

interface DiffLine {
  prefix: string;
  lineNum: string;
  content: string;
}

function parseLine(line: string): DiffLine | undefined {
  const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
  return match ? { prefix: match[1], lineNum: match[2], content: match[3] } : undefined;
}

/** Pi's single-line word highlighting, using the renderer's theme (also on PiG). */
function highlightWords(oldContent: string, newContent: string, theme: Theme): [string, string] {
  // Bound pathological word comparisons on the synchronous TUI render path.
  // A comparison beyond this budget still gets normal added/removed line colors.
  if (oldContent.length + newContent.length > 40_000) return [oldContent, newContent];
  const parts = diffWords(oldContent, newContent, { maxEditLength: 1_000 });
  if (!parts) return [oldContent, newContent];
  // diffWords ignores whitespace differences and can use the new side's spacing
  // in shared parts. Never let word highlighting alter either displayed line.
  const reconstructedOld = parts.filter(part => !part.added).map(part => part.value).join("");
  const reconstructedNew = parts.filter(part => !part.removed).map(part => part.value).join("");
  if (reconstructedOld !== oldContent || reconstructedNew !== newContent) return [oldContent, newContent];
  const lines = ["", ""];
  const firstChange = [true, true];
  for (const part of parts) {
    if (!part.removed && !part.added) {
      lines[0] += part.value;
      lines[1] += part.value;
      continue;
    }
    const side = part.removed ? 0 : 1;
    let value = part.value;
    if (firstChange[side]) {
      // Match Pi: don't inverse-highlight leading indentation/whitespace.
      const leading = value.match(/^\s*/)![0];
      lines[side] += leading;
      value = value.slice(leading.length);
      firstChange[side] = false;
    }
    if (value) lines[side] += theme.inverse(value);
  }
  return [lines[0], lines[1]];
}

/** Input must already be sanitized; only theme helpers may introduce ANSI. */
export function coloredDiff(diff: string, theme: Theme): string {
  const lines = diff.split("\n");
  const result: string[] = [];
  const colorLine = (line: string) => theme.fg(
    line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext",
    line,
  );
  let i = 0;
  while (i < lines.length) {
    if (parseLine(lines[i])?.prefix !== "-") {
      result.push(colorLine(lines[i++]));
      continue;
    }
    const start = i;
    while (i < lines.length && parseLine(lines[i])?.prefix === "-") i++;
    const addedStart = i;
    while (i < lines.length && parseLine(lines[i])?.prefix === "+") i++;
    if (addedStart - start === 1 && i - addedStart === 1) {
      const removed = parseLine(lines[start])!;
      const added = parseLine(lines[addedStart])!;
      const [oldContent, newContent] = highlightWords(removed.content, added.content, theme);
      result.push(colorLine(`-${removed.lineNum} ${oldContent}`));
      result.push(colorLine(`+${added.lineNum} ${newContent}`));
    } else {
      // Don't guess line pairing in a multi-line replacement block.
      for (let j = start; j < i; j++) result.push(colorLine(lines[j]));
    }
  }
  return result.join("\n");
}
