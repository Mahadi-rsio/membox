import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useRef, useState, useEffect, useMemo, useCallback } from "react";
import {
  Bot,
  Check,
  Copy,
  Download,
  History,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Send,
  Sparkles,
  Square,
  Trash2,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { useModels } from "@/hooks/use-models";
import { parseChatError } from "@/lib/chat-error";
import {
  type ChatSession,
  createNewSession,
  loadStoredSessions,
  saveStoredSessions,
  loadStoredActiveSessionId,
  saveStoredActiveSessionId,
  loadStoredSelectedModel,
  saveStoredSelectedModel,
  loadStoredPanelOpen,
  saveStoredPanelOpen,
} from "@/lib/storage";

/**
 * The UI never uploads the conversation history. `prepareSendMessagesRequest`
 * rewrites the request body so only the *latest* message (plus the selected
 * model) is sent to the server. The Memory Gateway supplies context/memory
 * server-side instead.
 */
function latestMessageBody(options: {
  messages: UIMessage[];
  model?: string;
}): { body: { message: UIMessage; model?: string } } {
  return {
    body: {
      message: options.messages[options.messages.length - 1],
      ...(options.model ? { model: options.model } : {}),
    },
  };
}

function messageText(message: UIMessage): string {
  if (message.parts && Array.isArray(message.parts)) {
    const textParts = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (textParts) return textParts;
  }
  return (message as { content?: string }).content || "";
}

function deriveSessionTitle(messages: UIMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New chat";
  const text = messageText(firstUser).replace(/\s+/g, " ").trim();
  if (!text) return "New chat";
  return text.length > 36 ? text.slice(0, 36) + "…" : text;
}

function formatChatExport(session: ChatSession, modelName?: string): string {
  const dateStr = new Date(session.createdAt).toLocaleString();
  const header = [
    `# ${session.title || "Remember Chat"}`,
    `Date: ${dateStr}`,
    modelName ? `Model: ${modelName}` : "",
    "",
    "---",
    "",
  ].filter(Boolean);

  const body = session.messages.map((m) => {
    const role = m.role === "user" ? "User" : "Assistant";
    const text = messageText(m);
    return `### ${role}\n\n${text || "(empty)"}\n`;
  });

  return [...header, ...body].join("\n");
}

function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;

  if (diff < min) return "Just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < day * 2) return "Yesterday";
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export default function Chat() {
  const { models, loading: modelsLoading } = useModels();

  // Sessions list initialized from localStorage
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    const stored = loadStoredSessions();
    if (stored.length > 0) return stored;
    return [createNewSession()];
  });

  // Active session ID initialized from localStorage or fallback to first session
  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    const storedActive = loadStoredActiveSessionId();
    const storedSessions = loadStoredSessions();
    if (storedActive && storedSessions.some((s) => s.id === storedActive)) {
      return storedActive;
    }
    return storedSessions[0]?.id || "";
  });

  // Default: DO NOT select any model by default!
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    loadStoredSelectedModel()
  );

  // Panel open state: default responsive check, persisted in localStorage
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    const isDesktop = typeof window !== "undefined" ? window.innerWidth >= 768 : true;
    return loadStoredPanelOpen(isDesktop);
  });

  const [copied, setCopied] = useState(false);

  // Persist sessions
  useEffect(() => {
    saveStoredSessions(sessions);
  }, [sessions]);

  // Persist activeSessionId
  useEffect(() => {
    if (activeSessionId) {
      saveStoredActiveSessionId(activeSessionId);
    }
  }, [activeSessionId]);

  // Persist selectedModel
  useEffect(() => {
    saveStoredSelectedModel(selectedModel);
  }, [selectedModel]);

  // Persist panelOpen
  useEffect(() => {
    saveStoredPanelOpen(panelOpen);
  }, [panelOpen]);

  // Make sure there is always a valid active session
  useEffect(() => {
    if (!sessions.some((s) => s.id === activeSessionId)) {
      if (sessions.length > 0) {
        setActiveSessionId(sessions[0].id);
      } else {
        const fresh = createNewSession();
        setSessions([fresh]);
        setActiveSessionId(fresh.id);
      }
    }
  }, [sessions, activeSessionId]);

  const activeSession = useMemo(() => {
    return (
      sessions.find((s) => s.id === activeSessionId) ||
      sessions[0] ||
      createNewSession()
    );
  }, [sessions, activeSessionId]);

  const handleUpdateMessages = useCallback(
    (sessionId: string, newMessages: UIMessage[]) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s;
          const currentTitle = s.title;
          const newTitle =
            currentTitle === "New chat" ? deriveSessionTitle(newMessages) : currentTitle;
          return {
            ...s,
            title: newTitle,
            updatedAt: Date.now(),
            messages: newMessages,
          };
        })
      );
    },
    []
  );

  function handleCreateNewChat() {
    const fresh = createNewSession();
    setSessions((prev) => [fresh, ...prev]);
    setActiveSessionId(fresh.id);
    if (window.innerWidth < 768) {
      setPanelOpen(false);
    }
  }

  function handleSelectSession(id: string) {
    setActiveSessionId(id);
    if (window.innerWidth < 768) {
      setPanelOpen(false);
    }
  }

  function handleDeleteSession(id: string) {
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      if (remaining.length === 0) {
        const fresh = createNewSession();
        setActiveSessionId(fresh.id);
        return [fresh];
      }
      if (activeSessionId === id) {
        setActiveSessionId(remaining[0].id);
      }
      return remaining;
    });
  }

  function handleClearAllSessions() {
    const fresh = createNewSession();
    setSessions([fresh]);
    setActiveSessionId(fresh.id);
  }

  async function handleCopyChat() {
    if (!activeSession || activeSession.messages.length === 0) return;
    const text = formatChatExport(activeSession, selectedModel);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy conversation:", err);
    }
  }

  function handleDownloadChat() {
    if (!activeSession || activeSession.messages.length === 0) return;
    const text = formatChatExport(activeSession, selectedModel);
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const slug =
      (activeSession.title || "chat")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 36) || "chat";
    a.href = url;
    a.download = `${slug}-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const hasMessages = activeSession.messages.length > 0;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* ChatGPT-style Side Panel (Sessions History) */}
      <HistoryPanel
        sessions={sessions}
        activeSessionId={activeSessionId}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        onSelectSession={handleSelectSession}
        onNewSession={handleCreateNewChat}
        onDeleteSession={handleDeleteSession}
        onClearAllSessions={handleClearAllSessions}
      />

      {/* Main Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Responsive Appbar */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-background/95 px-3 backdrop-blur sm:px-4">
          {/* Left side: Navigation / Brand */}
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            {/* Mobile drawer toggle */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 md:hidden"
              onClick={() => setPanelOpen(true)}
              aria-label="Open chat history panel"
            >
              <Menu className="h-4 w-4" />
            </Button>

            {/* Desktop panel open button - ONLY visible when panel is collapsed */}
            {!panelOpen && (
              <Button
                variant="ghost"
                size="icon"
                className="hidden h-8 w-8 md:inline-flex"
                onClick={() => setPanelOpen(true)}
                aria-label="Expand sidebar"
                title="Expand sidebar"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </Button>
            )}

            {/* Logo & Title */}
            <div className="flex items-center gap-2">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground shadow-xs">
                R
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold leading-tight sm:text-base">
                  Remember
                </h1>
                <p className="hidden truncate text-[11px] text-muted-foreground sm:block">
                  Memory-backed chat · latest message only
                </p>
              </div>
            </div>
          </div>

          {/* Right side: Model selector & Action buttons */}
          <div className="flex items-center gap-1.5 sm:gap-2">
            {/* Model Selector (Empty default) */}
            <Select
              value={selectedModel || undefined}
              onValueChange={(v) => setSelectedModel(v)}
              disabled={modelsLoading}
            >
              <SelectTrigger className="h-8 w-[135px] text-xs sm:h-9 sm:w-[185px] sm:text-sm md:w-[220px]">
                <SelectValue placeholder={modelsLoading ? "Loading models…" : "Select model"} />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-xs sm:text-sm">
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Copy Chat Button */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 sm:h-9 sm:w-9"
              onClick={handleCopyChat}
              disabled={!hasMessages}
              title={copied ? "Copied conversation!" : "Copy conversation"}
              aria-label="Copy conversation"
            >
              {copied ? (
                <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>

            {/* Download Chat Button */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 sm:h-9 sm:w-9"
              onClick={handleDownloadChat}
              disabled={!hasMessages}
              title="Download conversation (.md)"
              aria-label="Download conversation"
            >
              <Download className="h-4 w-4" />
            </Button>

            {/* Quick New Chat Button */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 sm:h-9 sm:w-9"
              onClick={handleCreateNewChat}
              title="New chat"
              aria-label="New chat"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {/* Active Session Chat View */}
        <ActiveChatSession
          key={activeSession.id}
          session={activeSession}
          selectedModel={selectedModel}
          onUpdateMessages={handleUpdateMessages}
        />
      </div>
    </div>
  );
}

/**
 * ChatGPT-style Session History Panel
 */
function HistoryPanel({
  sessions,
  activeSessionId,
  open,
  onClose,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  onClearAllSessions,
}: {
  sessions: ChatSession[];
  activeSessionId: string;
  open: boolean;
  onClose: () => void;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onDeleteSession: (id: string) => void;
  onClearAllSessions: () => void;
}) {
  const panelContent = (
    <div className="flex h-full flex-col">
      {/* Panel Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <History className="h-4 w-4" />
          <span>Chat History</span>
        </div>
        {/* Single close icon here! No double close icon in appbar */}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onClose}
          aria-label="Collapse panel"
          title="Collapse panel"
        >
          <PanelLeftClose className="h-4 w-4" />
        </Button>
      </div>

      {/* New Chat Button */}
      <div className="p-3">
        <Button
          variant="outline"
          className="w-full justify-start gap-2 border-border/80 shadow-xs hover:bg-accent"
          onClick={onNewSession}
        >
          <Plus className="h-4 w-4" />
          <span className="text-sm font-medium">New chat</span>
        </Button>
      </div>

      {/* Sessions List */}
      <ScrollArea className="flex-1 px-2">
        <div className="flex flex-col gap-1 pb-4">
          {sessions.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              No chat history yet.
            </p>
          ) : (
            sessions.map((s) => {
              const isActive = s.id === activeSessionId;
              return (
                <div
                  key={s.id}
                  onClick={() => onSelectSession(s.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectSession(s.id);
                    }
                  }}
                  className={cn(
                    "group relative flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-xs transition-colors select-none",
                    isActive
                      ? "bg-accent font-medium text-accent-foreground shadow-xs"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  )}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-70" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs leading-snug">{s.title || "New chat"}</p>
                      <p className="text-[10px] text-muted-foreground/70">
                        {formatTimeAgo(s.updatedAt)}
                      </p>
                    </div>
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(
                      "h-6 w-6 shrink-0 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100",
                      isActive && "opacity-80"
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSession(s.id);
                    }}
                    title="Delete chat"
                    aria-label={`Delete ${s.title || "chat"}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* Footer info & clear option */}
      <div className="flex items-center justify-between border-t border-border p-3 text-[11px] text-muted-foreground">
        <span>
          {sessions.length} {sessions.length === 1 ? "conversation" : "conversations"}
        </span>
        {sessions.length > 1 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-destructive"
            onClick={onClearAllSessions}
          >
            Clear all
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      {open && (
        <aside className="hidden h-full w-72 shrink-0 flex-col border-r border-border bg-muted/20 md:flex">
          {panelContent}
        </aside>
      )}

      {/* Mobile Drawer Backdrop & Drawer */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-xs md:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-full w-72 flex-col border-r border-border bg-background shadow-2xl transition-transform duration-200 ease-in-out md:hidden",
          open ? "translate-x-0" : "-translate-x-full pointer-events-none"
        )}
      >
        {panelContent}
      </aside>
    </>
  );
}

/**
 * Active Chat Session View
 */
function ActiveChatSession({
  session,
  selectedModel,
  onUpdateMessages,
}: {
  session: ChatSession;
  selectedModel: string;
  onUpdateMessages: (sessionId: string, messages: UIMessage[]) => void;
}) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const isInitialMount = useRef(true);

  const { messages, sendMessage, status, error, stop } = useChat({
    id: session.id,
    messages: session.messages,
    transport: new DefaultChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest: (options) =>
        latestMessageBody({ ...options, model: selectedModel }),
    }),
  });

  const busy = status === "submitted" || status === "streaming";
  const detailedError = useMemo(() => parseChatError(error), [error]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, busy]);

  // Sync messages update back to parent session state
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    onUpdateMessages(session.id, messages);
  }, [messages, session.id, onUpdateMessages]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy || !selectedModel) return;
    sendMessage({ text });
    setInput("");
  }

  function handleRetry() {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
      sendMessage({ text: messageText(lastUser) });
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      {/* Messages Scroll Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6">
          {messages.length === 0 && (
            <div className="py-16 text-center text-muted-foreground">
              <Bot className="mx-auto mb-3 h-10 w-10 opacity-40" />
              <p className="text-lg font-medium text-foreground">
                {selectedModel ? "Ask me anything" : "Select a model to begin"}
              </p>
              <p className="mx-auto mt-1 max-w-sm text-sm">
                {selectedModel
                  ? "I remember context across messages using the Memory Gateway."
                  : "Please choose an AI model from the top appbar to start chatting."}
              </p>
            </div>
          )}

          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          {busy && (
            <div className="flex items-center gap-3">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-primary/10 text-primary">
                  <Bot className="h-4 w-4" />
                </AvatarFallback>
              </Avatar>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="h-2 w-2 animate-pulse rounded-full bg-current" />
                Thinking…
              </div>
            </div>
          )}

          {error && <ErrorCard error={detailedError} onRetry={handleRetry} />}
        </div>
      </div>

      {/* Input Footer */}
      <footer className="border-t border-border bg-background/80 p-3 backdrop-blur sm:p-4">
        <form onSubmit={handleSubmit} className="mx-auto flex max-w-3xl flex-col gap-2">
          {!selectedModel && (
            <div className="flex items-center gap-1.5 px-1 text-xs text-amber-600 dark:text-amber-400">
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              <span>Please select a model above to begin chatting</span>
            </div>
          )}

          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder={selectedModel ? "Type a message…" : "Select a model above first…"}
              className="min-h-[48px] max-h-40 flex-1 resize-none"
              rows={1}
            />
            {busy ? (
              <Button type="button" variant="outline" size="icon" onClick={() => stop()}>
                <Square className="h-4 w-4" />
                <span className="sr-only">Stop</span>
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                disabled={!input.trim() || !selectedModel}
                title={!selectedModel ? "Please select a model first" : "Send message"}
              >
                <Send className="h-4 w-4" />
                <span className="sr-only">Send</span>
              </Button>
            )}
          </div>
        </form>

        <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-muted-foreground">
          {selectedModel ? selectedModel : "No model selected"}
        </p>
      </footer>
    </div>
  );
}

function MessageBubble({ message }: { message: UIMessage }) {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === "user";
  const text = messageText(message);

  async function handleCopyText() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy message:", err);
    }
  }

  return (
    <div
      className={cn("group flex w-full gap-2.5 sm:gap-3", isUser ? "flex-row-reverse" : "flex-row")}
    >
      <Avatar className="mt-0.5 h-8 w-8 shrink-0">
        <AvatarFallback
          className={cn(
            isUser ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary"
          )}
        >
          {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
        </AvatarFallback>
      </Avatar>

      <div className={cn("relative max-w-[85%] sm:max-w-[75%]", isUser ? "items-end" : "items-start")}>
        <Card
          className={cn(
            "whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed shadow-xs",
            isUser
              ? "rounded-br-sm bg-primary text-primary-foreground"
              : "rounded-bl-sm border-border/80 bg-card text-card-foreground"
          )}
        >
          {text || (isUser ? "…" : "")}
        </Card>

        {text && (
          <div
            className={cn(
              "mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100",
              isUser ? "justify-end" : "justify-start"
            )}
          >
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-foreground"
              onClick={handleCopyText}
              title="Copy message"
              aria-label="Copy message text"
            >
              {copied ? (
                <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorCard({
  error,
  onRetry,
}: {
  error: { message: string; status?: number; detail?: string };
  onRetry: () => void;
}) {
  return (
    <Card className="border-destructive/40 bg-destructive/10 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
          <Square className="h-4 w-4" />
          Something went wrong
        </div>
        {error.status && <Badge variant="destructive">HTTP {error.status}</Badge>}
      </div>
      <p className="mt-2 text-sm text-destructive/90">{error.message}</p>
      {error.detail && (
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/5 p-3 text-xs text-destructive/90">
          {error.detail}
        </pre>
      )}
      <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
        Try again
      </Button>
    </Card>
  );
}
