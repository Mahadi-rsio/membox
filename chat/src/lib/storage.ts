import type { UIMessage } from "@ai-sdk/react";

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: UIMessage[];
}

const STORAGE_KEYS = {
  SESSIONS: "remember_chat_sessions_v1",
  ACTIVE_SESSION_ID: "remember_active_session_id_v1",
  SELECTED_MODEL: "remember_selected_model_v1",
  PANEL_OPEN: "remember_panel_open_v1",
} as const;

export function createNewSession(title = "New chat"): ChatSession {
  const now = Date.now();
  return {
    id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `session_${now}_${Math.random().toString(36).slice(2, 9)}`,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function loadStoredSessions(): ChatSession[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.SESSIONS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch (err) {
    console.error("Failed to load chat sessions from localStorage:", err);
  }
  return [];
}

export function saveStoredSessions(sessions: ChatSession[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEYS.SESSIONS, JSON.stringify(sessions));
  } catch (err) {
    console.error("Failed to save chat sessions to localStorage:", err);
  }
}

export function loadStoredActiveSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION_ID);
  } catch {
    return null;
  }
}

export function saveStoredActiveSessionId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION_ID, id);
  } catch {}
}

export function loadStoredSelectedModel(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(STORAGE_KEYS.SELECTED_MODEL) || "";
  } catch {
    return "";
  }
}

export function saveStoredSelectedModel(model: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEYS.SELECTED_MODEL, model);
  } catch {}
}

export function loadStoredPanelOpen(defaultVal: boolean): boolean {
  if (typeof window === "undefined") return defaultVal;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PANEL_OPEN);
    if (raw === null) return defaultVal;
    return raw === "true";
  } catch {
    return defaultVal;
  }
}

export function saveStoredPanelOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEYS.PANEL_OPEN, String(open));
  } catch {}
}
