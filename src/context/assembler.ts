import type { SelectableItem } from "./selector.js";
import type { MemoryItem } from "../db/schema/memory.js";

export function formatCanonicalMemoryBlock(items: MemoryItem[]): string {
  if (!items || items.length === 0) {
    return "";
  }

  const grouped: Record<string, string[]> = {};
  for (const item of items) {
    const rawType = item.type || "fact";
    const mtype = rawType
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    if (!grouped[mtype]) {
      grouped[mtype] = [];
    }
    const status = (item.status || "").toLowerCase();
    const prefix =
      status === "superseded"
        ? "(previous) "
        : status === "revoked"
          ? "(revoked) "
          : "";

    let entry = item.content;
    const pred = (item.predicate || "").trim();
    const val = (item.value || "").trim();
    if (pred && val) {
      // Structured SPV reads clearer than value-only preference content
      // ("verbose code" → "disliked_verbose_code = verbose code").
      if (pred.startsWith("disliked_")) {
        entry = `dislikes ${pred.replace(/^disliked_/, "").replace(/_/g, " ")}: ${val}`;
      } else if (pred.startsWith("favorite_") || pred.startsWith("preferred_")) {
        entry = `${pred.replace(/_/g, " ")}: ${val}`;
      } else if (
        rawType.toLowerCase() === "preference" ||
        (item.content || "").trim() === val
      ) {
        entry = `${pred.replace(/_/g, " ")}: ${val}`;
      }
    }

    grouped[mtype].push(`${prefix}${entry}`);
  }

  const lines = ["[Project Memory & Canonical State]"];
  const sortedCategories = Object.keys(grouped).sort();
  for (const category of sortedCategories) {
    lines.push(`• ${category}:`);
    for (const entry of grouped[category]) {
      lines.push(`  - ${entry}`);
    }
  }

  return lines.join("\n");
}

export function assembleContextMessages(
  selectedItems: SelectableItem[],
  options?: { hasCanonicalMemory?: boolean }
): Array<Record<string, any>> {
  const systemItems = selectedItems.filter((i) => i.kind === "system");
  const canonicalItems = selectedItems
    .filter((i) => i.kind === "canonical_memory" && i.memoryItem)
    .map((i) => i.memoryItem!);
  const conversationItems = selectedItems.filter((i) =>
    ["message", "tool_result"].includes(i.kind)
  );
  const newMessages = selectedItems.filter((i) => i.kind === "new_message");

  let memoryText =
    canonicalItems.length > 0 ? formatCanonicalMemoryBlock(canonicalItems) : "";

  const assembled: Array<Record<string, any>> = [];

  // 1. System messages
  if (systemItems.length > 0) {
    for (const s of systemItems) {
      const baseMsg = { ...(s.rawMessage || { role: "system", content: s.content }) };
      if (memoryText) {
        const existingContent = String(baseMsg.content || "");
        baseMsg.content = `${existingContent}\n\n${memoryText}`.trim();
        memoryText = ""; // Inject once into first system message
      }
      assembled.push(baseMsg);
    }
  } else if (memoryText) {
    assembled.push({ role: "system", content: memoryText });
  }

  // 2. Selected chronological turns
  const sortedTurns = [...conversationItems].sort((a, b) => a.ordinal - b.ordinal);
  for (const item of sortedTurns) {
    if (item.rawMessage) {
      assembled.push({ ...item.rawMessage });
    } else {
      assembled.push({ role: "user", content: item.content });
    }
  }

  // 3. New user message(s)
  for (const item of newMessages) {
    if (item.rawMessage) {
      assembled.push({ ...item.rawMessage });
    } else {
      assembled.push({ role: "user", content: item.content });
    }
  }

  return assembled;
}
