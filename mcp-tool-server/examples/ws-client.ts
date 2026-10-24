import WebSocket from "ws";

const host = process.env.MCP_HOST ?? "127.0.0.1";
const port = Number(process.env.MCP_PORT ?? 3001);
const token = process.env.MCP_API_TOKEN ?? "dev-secret-change-me";
const socket = new WebSocket(`ws://${host}:${port}/ws?token=${encodeURIComponent(token)}`);

async function sendJsonRpc(method: string, params: Record<string, unknown> = {}, id = Date.now()) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for response to ${method}`)), 5000);

    socket.once("message", (raw) => {
      clearTimeout(timeout);
      try {
        const payload = JSON.parse(raw.toString("utf8"));
        resolve(payload as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });

    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

socket.on("open", async () => {
  try {
    const initResponse = await sendJsonRpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "example-client", version: "1.0.0" }
    }, 1);
    console.log("Initialize response:", initResponse);

    const toolsResponse = await sendJsonRpc("tools/list", {}, 2);
    console.log("Discovered tools:", toolsResponse);

    const callResponse = await sendJsonRpc("tools/call", {
      name: "search_web",
      arguments: { query: "wireless headset", maxResults: 2 }
    }, 3);
    console.log("Tool call response:", callResponse);

    socket.close();
  } catch (error) {
    console.error("Example client failed.", error);
    socket.close();
    process.exitCode = 1;
  }
});

socket.on("error", (error) => {
  console.error("WebSocket error", error);
  process.exitCode = 1;
});
