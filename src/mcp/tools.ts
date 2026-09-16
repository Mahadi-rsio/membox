/**
 * MCP tool definitions for Remember.
 *
 * Tools:
 *   - memory_session_create    create/reuse a stable session
 *   - memory_search            search persistent memory (via Gateway)
 *   - memory_save              save a fact (via Gateway)
 *   - memory_update            update a fact (via Gateway)
 *   - memory_forget            forget a fact (via Gateway)
 *   - memory_context_search    search the current conversation context
 *
 * All persistent-memory tools delegate to the Gateway. The MCP layer only tracks
 * sessions and the current conversation; it never becomes a second database.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionStore } from "./session";
import type { ContextTracker } from "./context";
import type { GatewayClient } from "./gateway-client";

export interface ToolDeps {
  sessions: SessionStore;
  context: ContextTracker;
  gateway: GatewayClient;
}

function textResult(content: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(content, null, 2) }],
  };
}

function requireSession(deps: ToolDeps, sessionId: string | undefined, create = false) {
  if (sessionId) {
    const existing = deps.sessions.get(sessionId);
    if (existing) return existing;
    if (!create) {
      throw new Error(`Unknown session: ${sessionId}. Create one with memory_session_create first.`);
    }
  }
  return deps.sessions.create(sessionId);
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  server.tool(
    "memory_session_create",
    "Create (or reuse) a stable memory session. A session remains stable across many messages; do not create a new one per message. If an existing session_id is supplied it is reused.",
    {
      session_id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/)
        .optional()
        .describe("Optional existing session id to reuse."),
    },
    {},
    async ({ session_id }) => {
      const session = requireSession(deps, session_id, true);
      return textResult({ session_id: session.sessionId });
    }
  );

  server.tool(
    "memory_search",
    "Search persistent memory stored by the Memory Gateway. Returns durable facts relevant to the query.",
    {
      session_id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/)
        .describe("The session id returned by memory_session_create."),
      query: z.string().describe("The search query, e.g. 'favorite color'."),
      limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)."),
    },
    {},
    async ({ session_id, query, limit }) => {
      requireSession(deps, session_id, false);
      const res = await deps.gateway.searchMemory({ sessionId: session_id!, query, limit });
      return textResult({
        session_id: res.session_id,
        query: res.query,
        results: res.results,
      });
    }
  );

  server.tool(
    "memory_save",
    "Explicitly save a fact to persistent memory through the Gateway. Conflicts/updates follow the normal memory engine rules.",
    {
      session_id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/)
        .describe("The session id returned by memory_session_create."),
      value: z.string().describe("The fact value, e.g. 'Mahadi'."),
      subject: z.string().optional().describe("Entity/subject, e.g. 'user' or a project name."),
      attribute: z.string().optional().describe("Attribute/predicate, e.g. 'name'."),
      type: z
        .enum(["fact", "decision", "constraint", "preference", "goal", "architecture", "important_event", "active_task", "temporary_state"])
        .optional()
        .describe("Canonical memory type (default fact)."),
      scope: z.enum(["user", "project", "session"]).optional().describe("Memory scope."),
    },
    {},
    async ({ session_id, value, subject, attribute, type, scope }) => {
      requireSession(deps, session_id, false);
      const res = await deps.gateway.saveMemory({
        sessionId: session_id!,
        value,
        subject,
        attribute,
        type,
        scope,
      });
      return textResult(res);
    }
  );

  server.tool(
    "memory_update",
    "Update the value of an existing memory item (by id or topic). The old value is superseded and the new value becomes current.",
    {
      session_id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/)
        .describe("The session id returned by memory_session_create."),
      value: z.string().describe("The new value, e.g. 'red'."),
      id: z.number().int().optional().describe("Numeric id of the memory item to update."),
      topic_key: z.string().optional().describe("Topic key of the memory item to update."),
      attribute: z.string().optional().describe("Attribute/predicate."),
      subject: z.string().optional().describe("Entity/subject."),
      type: z
        .enum(["fact", "decision", "constraint", "preference", "goal", "architecture", "important_event", "active_task", "temporary_state"])
        .optional()
        .describe("Canonical memory type."),
    },
    {},
    async ({ session_id, value, id, topic_key, attribute, subject, type }) => {
      requireSession(deps, session_id, false);
      const res = await deps.gateway.updateMemory({
        sessionId: session_id!,
        value,
        id,
        topicKey: topic_key,
        attribute,
        subject,
        type,
      });
      return textResult(res);
    }
  );

  server.tool(
    "memory_forget",
    "Forget (revoke) a memory by id, topic, attribute, or content match. Revoked memories are excluded from future context but preserved in the archive.",
    {
      session_id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/)
        .describe("The session id returned by memory_session_create."),
      id: z.number().int().optional().describe("Numeric id of the memory to forget."),
      topic_key: z.string().optional().describe("Topic key to forget."),
      attribute: z.string().optional().describe("Attribute/predicate to forget."),
      content: z.string().optional().describe("Content substring to match for forgetting."),
    },
    {},
    async ({ session_id, id, topic_key, attribute, content }) => {
      requireSession(deps, session_id, false);
      const res = await deps.gateway.forgetMemory({
        sessionId: session_id!,
        id,
        topicKey: topic_key,
        attribute,
        content,
      });
      return textResult(res);
    }
  );

  server.tool(
    "memory_context_search",
    "Search the current conversation context (recent user/assistant messages) for messages relevant to the query. Returns only relevant messages, not the full history.",
    {
      session_id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/)
        .describe("The session id returned by memory_session_create."),
      query: z.string().describe("The query to match against the conversation context."),
      limit: z.number().int().min(1).max(20).optional().describe("Max relevant messages to return (default 5)."),
    },
    {},
    async ({ session_id, query, limit }) => {
      requireSession(deps, session_id, false);
      const matches = deps.context.search(session_id!, query, limit ?? 5);
      return textResult({
        session_id,
        query,
        relevant_messages: matches,
        count: matches.length,
      });
    }
  );
}
