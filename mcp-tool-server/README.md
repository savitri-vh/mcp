# MCP Tool Server

This project implements a small Model Context Protocol (MCP) service in Node.js with TypeScript. It exposes JSON-RPC over HTTP and WebSocket transports, includes basic authentication, and registers two tools:

- `search_web` — searches the web using Brave Search for a query with optional site restriction.
- `file_manager` — lists, reads, or writes files relative to a configured root directory.

## Features

- JSON-RPC 2.0 request handling
- `GET /health` and `GET /tools` discovery endpoints
- `POST /mcp` HTTP transport for JSON-RPC
- `ws://host:port/ws` WebSocket transport for the same MCP methods
- Token-based authentication via `Authorization: Bearer <token>` or `?token=` query parameter
- Structured tool response results with `content` and `structuredContent`
- Logging, validation, and safe path handling

## Quick start

```bash
cd mcp-tool-server
npm install
npm run build
npm start
```

Set the variables from `.env.example` in your shell or copy that file to `.env` and replace its placeholder values. The server listens at `http://127.0.0.1:3001`; change the example API token before exposing it beyond localhost.

## API usage

### HTTP discovery

```bash
curl -H "Authorization: Bearer dev-secret-change-me" http://127.0.0.1:3001/tools
```

### HTTP tool call

```bash
curl -X POST http://127.0.0.1:3001/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dev-secret-change-me" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "search_web",
      "arguments": {
        "query": "wireless headset",
        "maxResults": 2
      }
    }
  }'
```

### WebSocket client

```bash
node --import tsx examples/ws-client.ts
```

The example client connects using the configured token in the query string.

## Example MCP JSON-RPC request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {
      "name": "example-client",
      "version": "1.0.0"
    }
  }
}
```

## Environment variables

- `MCP_API_TOKEN` — bearer secret for authentication.
- `MCP_HOST` — default `127.0.0.1`.
- `MCP_PORT` — default `3001`.
- `MCP_FILE_ROOT` — workspace root used by `file_manager`.
- `BRAVE_SEARCH_API_KEY` — Brave Search API subscription token required by `search_web`.
- `MCP_LOG_LEVEL` — log verbosity (`debug`, `info`, `warn`, `error`).

`file_manager` resolves paths relative to `MCP_FILE_ROOT`, rejects traversal outside that root, and checks symlinks before reading or writing. Set the root to the smallest directory the tool needs. The default is the server's current working directory.

`search_web` sends requests to Brave Search's Web Search API. Create an API subscription token in Brave Search, set `BRAVE_SEARCH_API_KEY`, and restart the server. The tool returns a clear configuration error if the key is missing; it does not generate placeholder results.

## Key files

- `src/mcp-server.ts` — HTTP + WebSocket JSON-RPC server.
- `src/tools.ts` — tool definition registry and execution logic.
- `examples/ws-client.ts` — example client for discovery and invocation.
