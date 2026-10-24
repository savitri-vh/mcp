import { fileURLToPath } from "node:url";
import path from "node:path";
import { createMcpServer } from "./mcp-server.js";

const isDirectExecution = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  const server = createMcpServer();
  void server.start();

  process.on("SIGINT", () => {
    void server.close().then(() => process.exit(0));
  });
}

export { createMcpServer };
