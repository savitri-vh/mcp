import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createMcpServer } from "../src/mcp-server.js";
import { config } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { callTool } from "../src/tools.js";

const token = "test-token";
const quietLogger = new Logger("error");

test("search_web uses Brave Search and maps results to the declared output", async () => {
  let requestedUrl: URL | undefined;
  let requestedHeaders: unknown;
  const result = await callTool("search_web", {
    query: "wireless headset",
    site: "example.org",
    maxResults: 2
  }, {
    logger: quietLogger,
    searchApiKey: "test-brave-key",
    fetch: async (input, init) => {
      requestedUrl = new URL(input);
      requestedHeaders = init?.headers;
      return new Response(JSON.stringify({
        web: {
          results: [{
            title: "Headset review",
            url: "https://example.org/reviews/headsets",
            description: "A headset review."
          }]
        }
      }), { status: 200 });
    }
  });

  assert.equal(requestedUrl?.origin, "https://api.search.brave.com");
  assert.equal(requestedUrl?.pathname, "/res/v1/web/search");
  assert.equal(requestedUrl?.searchParams.get("q"), "site:example.org wireless headset");
  assert.equal(requestedUrl?.searchParams.get("count"), "2");
  assert.equal(JSON.stringify(requestedHeaders), JSON.stringify({
    Accept: "application/json",
    "X-Subscription-Token": "test-brave-key"
  }));
  assert.deepEqual(result, {
    results: [{
      title: "Headset review",
      url: "https://example.org/reviews/headsets",
      summary: "A headset review.",
      source: "example.org"
    }],
    totalResults: 1
  });
});

test("search_web reports missing API configuration and provider failures", async () => {
  await assert.rejects(
    callTool("search_web", { query: "laptop" }, { logger: quietLogger, searchApiKey: "" }),
    /Set BRAVE_SEARCH_API_KEY/
  );

  await assert.rejects(
    callTool("search_web", { query: "laptop" }, {
      logger: quietLogger,
      searchApiKey: "test-brave-key",
      fetch: async () => new Response("rate limited", { status: 429 })
    }),
    /HTTP 429/
  );
});

test("file_manager prevents path traversal outside the configured root", async () => {
  const originalRoot = config.fileRoot;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-root-"));
  config.fileRoot = tempRoot;

  try {
    await assert.rejects(
      callTool("file_manager", { operation: "read", path: "..\\outside.txt" }, { logger: quietLogger }),
      /Path traversal is not allowed/
    );
  } finally {
    config.fileRoot = originalRoot;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("file_manager refuses paths that escape through a symbolic link", async () => {
  const originalRoot = config.fileRoot;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-symlink-"));
  const root = path.join(tempRoot, "root");
  const outside = path.join(tempRoot, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
  await fs.symlink(outside, path.join(root, "external"), "junction");
  config.fileRoot = root;

  try {
    await assert.rejects(
      callTool("file_manager", { operation: "read", path: path.join("external", "secret.txt") }, { logger: quietLogger }),
      /Symbolic links outside the configured file root/
    );
    await assert.rejects(
      callTool("file_manager", {
        operation: "write",
        path: path.join("external", "new.txt"),
        content: "outside"
      }, { logger: quietLogger }),
      /Symbolic links outside the configured file root/
    );
  } finally {
    config.fileRoot = originalRoot;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("HTTP discovery and tool invocation work with authentication", async () => {
  const server = createMcpServer({
    host: "127.0.0.1",
    port: 0,
    token,
    searchApiKey: "test-brave-key",
    fetch: async () => new Response(JSON.stringify({
      web: { results: [{ title: "Laptop", url: "https://example.org/laptop", description: "A laptop." }] }
    }), { status: 200 })
  });

  const started = await server.start();
  const baseUrl = `http://127.0.0.1:${started.port}`;

  try {
    const unauthenticated = await fetch(`${baseUrl}/tools`);
    assert.equal(unauthenticated.status, 401);

    const tools = await fetch(`${baseUrl}/tools`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(tools.status, 200);
    const body = (await tools.json()) as { tools?: Array<{ name: string }> };
    assert.ok(Array.isArray(body.tools));
    assert.ok(body.tools.some((tool: { name: string }) => tool.name === "search_web"));
    assert.ok(body.tools.some((tool: { name: string }) => tool.name === "file_manager"));

    const call = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: {
          name: "search_web",
          arguments: { query: "laptop", maxResults: 2 }
        }
      })
    });

    assert.equal(call.status, 200);
    const result = (await call.json()) as { jsonrpc: string; result?: { structuredContent?: { results?: unknown[] } } };
    assert.equal(result.jsonrpc, "2.0");
    assert.ok(result.result && typeof result.result === "object");
    assert.ok(Array.isArray(result.result.structuredContent?.results));
  } finally {
    await server.close();
  }
});

test("WebSocket transport successfully discovers and invokes registered tools", async () => {
  const server = createMcpServer({
    host: "127.0.0.1",
    port: 0,
    token
  });

  const opened = await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${opened.port}/ws?token=${token}`);

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    const initialize = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const onMessage = (raw: Buffer) => {
        try {
          const payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          resolve(payload);
        } catch (error) {
          reject(error);
        } finally {
          socket.off("message", onMessage);
        }
      };
      socket.on("message", onMessage);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }));
    });

    assert.equal(initialize.jsonrpc, "2.0");

    const discovered = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const onMessage = (raw: Buffer) => {
        try {
          const payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          resolve(payload);
        } catch (error) {
          reject(error);
        } finally {
          socket.off("message", onMessage);
        }
      };

      socket.on("message", onMessage);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    });

    assert.equal(discovered.jsonrpc, "2.0");
    const toolList = ((discovered.result as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []);
    assert.ok(toolList.some(tool => tool.name === "file_manager"));

    const toolCall = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const onMessage = (raw: Buffer) => {
        try {
          const payload = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          resolve(payload);
        } catch (error) {
          reject(error);
        } finally {
          socket.off("message", onMessage);
        }
      };

      socket.on("message", onMessage);
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "file_manager",
          arguments: {
            operation: "read",
            path: "README.md"
          }
        }
      }));
    });

    assert.equal((toolCall.error as { code?: number } | undefined)?.code, undefined);
    assert.ok(typeof ((toolCall.result as { structuredContent?: { content?: string } } | undefined)?.structuredContent?.content) === "string");
  } finally {
    socket.close();
    await delay(100);
    await server.close();
  }
});
