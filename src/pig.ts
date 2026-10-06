import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { Capture } from "./capture.ts";
import { asRecord, DETAILS_KEY, readChanges } from "./changes.ts";
import { diffSection, inlineText } from "./render.ts";

export const PIG_ENTRY_TYPE = "pi-codemode-diff:pig";

/**
 * D89 prevents wrapping next() across PiG's process boundary. Keep its native
 * codemode card untouched and draw a separate, non-model-facing custom entry.
 * Publishing at tool_execution_end includes final nested tool error statuses.
 */
export function registerPiGDisplay(pi: ExtensionAPI, capture: Capture): (toolCallId: string) => void {
  pi.registerEntryRenderer(PIG_ENTRY_TYPE, (entry, options, theme) => {
    const data = asRecord(entry.data);
    const changes = readChanges(data);
    if (typeof data?.toolCallId !== "string" || !changes?.length) return undefined;
    const component = new Container();
    component.addChild(new Text(theme.fg("muted", `codemode ${inlineText(data.toolCallId)}`), 0, 0));
    component.addChild(diffSection(changes, options.expanded, theme));
    return component;
  });

  return (toolCallId) => {
    const details = capture.details(toolCallId);
    if (details) pi.appendEntry(PIG_ENTRY_TYPE, { toolCallId, [DETAILS_KEY]: details });
  };
}
