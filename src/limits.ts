/** Display-only budgets. Never restrict file mutations or model-facing results. */
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_TEXT_LINES = 2_000;
export const MAX_DIFF_BYTES = 64 * 1024;
export const MAX_DIFF_LINES = 2_000;
export const MAX_BATCH_DIFF_BYTES = 256 * 1024;
export const MAX_BATCH_DIFF_LINES = 8_000;

/** Count logical lines without allocating a split array; CRLF is one ending. */
export function lineCount(text: string, stopAfter = Infinity): number {
  if (!text.length) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n" && text[i] !== "\r") continue;
    if (text[i] === "\r" && text[i + 1] === "\n") i++;
    // A final line ending terminates the last line, not an extra empty line.
    if (i < text.length - 1 && ++lines > stopAfter) return lines;
  }
  return lines;
}

export function textFits(text: string, maxBytes: number, maxLines: number): boolean {
  // UTF-8 bytes are never fewer than JS code units. Reject long strings cheaply.
  return text.length <= maxBytes && Buffer.byteLength(text, "utf8") <= maxBytes &&
    lineCount(text, maxLines) <= maxLines;
}

export function writeTextFits(text: string): boolean {
  return textFits(text, MAX_TEXT_BYTES, MAX_TEXT_LINES);
}
