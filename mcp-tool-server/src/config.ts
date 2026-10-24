import path from "node:path";
import process from "node:process";
import "dotenv/config";

export const config = {
  host: process.env.MCP_HOST ?? "127.0.0.1",
  port: Number(process.env.MCP_PORT ?? 3001),
  apiToken: process.env.MCP_API_TOKEN ?? "dev-secret-change-me",
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY,
  fileRoot: path.resolve(process.cwd(), process.env.MCP_FILE_ROOT ?? "."),
  logLevel: process.env.MCP_LOG_LEVEL ?? "info"
};
