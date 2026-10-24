import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { Logger } from "./logger.js";
import { config } from "./config.js";
import { callTool, toolDefinitions } from "./tools.js";

export type JsonRpcId = string | number | null;
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

export type ToolCallResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) }
  };
}

async function handleJsonRpcMessage(
  message: unknown,
  logger: Logger,
  toolOptions: { searchApiKey?: string; fetch?: typeof fetch } = {}
): Promise<JsonRpcResponse | null> {
  if (!isObject(message)) {
    return errorResponse(null, -32600, "Invalid JSON-RPC request.");
  }

  const method = typeof message.method === "string" ? message.method : undefined;
  const requestId = typeof message.id === "string" || typeof message.id === "number" || message.id === null ? message.id : null;

  if (!method) {
    return errorResponse(requestId, -32600, "JSON-RPC method is required.");
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "ping") {
    return {
      jsonrpc: "2.0",
      id: requestId,
      result: { ok: true }
    };
  }

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: requestId,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {
            listChanged: true
          }
        },
        serverInfo: {
          name: "computer-store-mcp-server",
          version: "1.0.0"
        },
        instructions: "Use the tools/list and tools/call methods to discover and execute tools."
      }
    };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: requestId,
      result: {
        tools: toolDefinitions
      }
    };
  }

  if (method === "tools/call") {
    const params = isObject(message.params) ? message.params : {};
    const toolName = typeof params.name === "string" ? params.name : "";
    const argumentsObject = isObject(params.arguments) ? params.arguments : {};

    if (!toolName) {
      return errorResponse(requestId, -32602, "Tool name is required for tools/call.");
    }

    try {
      const result = await callTool(toolName, argumentsObject, {
        logger,
        searchApiKey: toolOptions.searchApiKey ?? config.braveSearchApiKey,
        ...(toolOptions.fetch ? { fetch: toolOptions.fetch } : {})
      });
      const response: ToolCallResult = {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
        isError: false
      };
      return {
        jsonrpc: "2.0",
        id: requestId,
        result: response as Record<string, unknown>
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown tool execution error.";
      logger.error("Tool invocation failed", { tool: toolName, error: message });
      return errorResponse(requestId, -32603, message, { tool: toolName });
    }
  }

  return errorResponse(requestId, -32601, `Method not found: ${method}`);
}

export function createMcpServer(options: {
  host?: string;
  port?: number;
  token?: string;
  logger?: Logger | undefined;
  searchApiKey?: string;
  fetch?: typeof fetch;
} = {}) {
  const host = options.host ?? config.host;
  const port = options.port ?? config.port;
  const resolvedToken = options.token ?? config.apiToken;
  const logger = options.logger ?? new Logger(config.logLevel as "debug" | "info" | "warn" | "error");

  const isAuthorized = (headers: http.IncomingHttpHeaders, url?: string): boolean => {
    const authorization = typeof headers.authorization === "string" ? headers.authorization : undefined;
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    const headerToken = typeof headers["x-mcp-token"] === "string" ? headers["x-mcp-token"] : undefined;
    const queryToken = url ? new URL(url, "http://localhost").searchParams.get("token") : undefined;
    const token = bearer ?? headerToken ?? queryToken;
    return !resolvedToken || token === resolvedToken;
  };
  const httpServer = http.createServer(async (request, response) => {
    if (!request.url) {
      sendJson(response, 400, { error: "Request URL is required." });
      return;
    }

    const url = new URL(request.url, `http://${host}:${port}`);

    if (request.method === "GET" && url.pathname === "/health") {
      if (!isAuthorized(request.headers, request.url)) {
        sendJson(response, 401, { error: "Unauthorized." });
        return;
      }
      sendJson(response, 200, { status: "ok", tools: toolDefinitions.map(tool => tool.name) });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tools") {
      if (!isAuthorized(request.headers, request.url)) {
        sendJson(response, 401, { error: "Unauthorized." });
        return;
      }
      sendJson(response, 200, { tools: toolDefinitions });
      return;
    }

    if (request.method === "POST" && url.pathname === "/mcp") {
      if (!isAuthorized(request.headers, request.url)) {
        sendJson(response, 401, { error: "Unauthorized." });
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      const rawBody = Buffer.concat(chunks).toString("utf8");
      if (!rawBody.trim()) {
        sendJson(response, 400, { error: "Request body is required." });
        return;
      }

      try {
        const parsed = JSON.parse(rawBody);
        const responsePayload = await handleJsonRpcMessage(parsed, logger, options);
        sendJson(response, responsePayload ? 200 : 204, responsePayload ?? {});
      } catch (error) {
        const message = error instanceof Error ? error.message : "Malformed JSON-RPC payload.";
        logger.error("HTTP JSON-RPC request failed", { error: message });
        sendJson(response, 400, errorResponse(null, -32700, message));
      }
      return;
    }

    if (request.method === "GET") {
      sendJson(response, 404, { error: `Unknown route: ${url.pathname}` });
      return;
    }

    sendJson(response, 404, { error: `Unknown route: ${url.pathname}` });
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws"
  });

  wss.on("connection", (socket: WebSocket, request) => {
    const url = request.url ? new URL(request.url, `http://${host}:${port}`) : null;
    if (!isAuthorized(request.headers, request.url)) {
      socket.close(1008, "Unauthorized");
      logger.warn("Rejected WebSocket connection due to missing or invalid token.");
      return;
    }

    socket.on("message", async (rawMessage) => {
      try {
        const payload = JSON.parse(rawMessage.toString("utf8"));
        const result = await handleJsonRpcMessage(payload, logger, options);
        if (result) {
          socket.send(JSON.stringify(result));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Malformed WebSocket JSON-RPC payload.";
        logger.error("WebSocket JSON-RPC request failed", { error: message });
        socket.send(JSON.stringify(errorResponse(null, -32700, message)));
      }
    });

    socket.on("error", (error) => {
      logger.error("WebSocket error", { error: error.message });
    });

    if (url?.searchParams.get("token")) {
      logger.info("WebSocket client connected", { path: url.pathname });
    }
  });

  function start(): Promise<{ port: number; url: string }> {
    return new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        const address = httpServer.address();
        const actualPort = typeof address === "object" && address ? address.port : port;
        logger.info("MCP server listening", { host, port: actualPort, wsPath: "/ws" });
        resolve({ port: actualPort, url: `http://${host}:${actualPort}` });
      });
    });
  }

  async function close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return { start, close, server: httpServer, wss, logger };
}
