/**
 * MCP server entry — mounts the Remember MCP server on the Web Standard
 * Streamable HTTP transport so it can run inside the Cloudflare Worker.
 *
 * This registers the six memory tools, wires them to the Gateway client, the
 * in-memory session store, and the current-context tracker.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import type { HonoContext } from "../env";
import { GatewayClient } from "./gateway-client";
import { MemorySessionStore } from "./session";
import { ContextTracker } from "./context";
import { registerTools, type ToolDeps } from "./tools";

export const MCP_SERVER_NAME = "remember-memory-gateway";
export const MCP_SERVER_VERSION = "0.1.0";

/** Build the MCP server with the given dependencies. */
export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Remember Memory Gateway MCP. Every user message should be processed through the gateway " +
        "for persistent memory learning and retrieval. Use memory_session_create to establish a " +
        "stable session, then rely on processMessage for every-message memory integration.",
    }
  );
  registerTools(server, deps);
  return server;
}

/**
 * Handle an MCP HTTP request against the given dependencies.
 *
 * Each request uses a fresh transport (stateless HTTP); the session store and
 * context tracker are shared across requests so sessions remain stable across
 * multiple messages.
 */
export async function handleMcpRequest(
  c: Context<HonoContext>,
  deps: ToolDeps
): Promise<Response> {
  const server = createMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
}

/** Default dependencies built from the environment bindings. */
export function defaultMcpDeps(env: HonoContext["Bindings"]): ToolDeps {
  const gateway = new GatewayClient({
    baseUrl: env.GATEWAY_URL || undefined,
    apiKey: env.GATEWAY_API_KEY || undefined,
  });
  return {
    sessions: new MemorySessionStore(),
    context: new ContextTracker(),
    gateway,
  };
}
