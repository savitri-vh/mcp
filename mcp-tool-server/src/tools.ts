import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { Logger } from "./logger.js";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  outputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

export type ToolContext = {
  logger: Logger;
  searchApiKey?: string | undefined;
  fetch?: typeof fetch | undefined;
};

const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};

async function ensureSafePath(requestedPath: string, operation: unknown): Promise<{ root: string; target: string }> {
  const root = await fs.realpath(config.fileRoot);
  const candidate = path.resolve(root, requestedPath);
  if (!isWithinRoot(root, candidate)) {
    throw new Error("Path traversal is not allowed.");
  }

  if (operation !== "write") {
    const target = await fs.realpath(candidate);
    if (!isWithinRoot(root, target)) {
      throw new Error("Symbolic links outside the configured file root are not allowed.");
    }
    return { root, target };
  }

  let existingPath = candidate;
  while (true) {
    try {
      const resolvedExistingPath = await fs.realpath(existingPath);
      if (!isWithinRoot(root, resolvedExistingPath)) {
        throw new Error("Symbolic links outside the configured file root are not allowed.");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parentPath = path.dirname(existingPath);
      if (parentPath === existingPath) {
        throw new Error("Unable to resolve a safe parent directory for the requested file.");
      }
      existingPath = parentPath;
    }
  }

  return { root, target: candidate };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "search_web",
    description: "Search the web using Brave Search for results matching a query and optional site filter.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text query to search for." },
        maxResults: { type: "integer", minimum: 1, maximum: 10, default: 5, description: "Maximum results to return." },
        site: { type: "string", description: "Optional domain or host to restrict results to." }
      },
      required: ["query"],
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              summary: { type: "string" },
              source: { type: "string" }
            },
            required: ["title", "url", "summary", "source"],
            additionalProperties: false
          }
        },
        totalResults: { type: "integer" }
      },
      required: ["results", "totalResults"],
      additionalProperties: false
    }
  },
  {
    name: "file_manager",
    description: "Read and write local files within the configured workspace root.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "read", "write"],
          description: "The file operation to perform." 
        },
        path: { type: "string", description: "Target file or directory path relative to the configured root." },
        content: { type: "string", description: "File content used when operation is write." },
        encoding: { type: "string", enum: ["utf8"], default: "utf8", description: "Text encoding." }
      },
      required: ["operation", "path"],
      additionalProperties: false
    },
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        files: {
          type: "array",
          items: { type: "string" }
        },
        created: { type: "boolean" }
      },
      required: ["path"],
      additionalProperties: false
    }
  }
];

export async function callTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>> {
  const logger = context.logger;

  switch (name) {
    case "search_web": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const maxResults = typeof args.maxResults === "number" ? Math.min(Math.max(args.maxResults, 1), 10) : 5;
      const site = typeof args.site === "string" ? args.site.trim() : undefined;

      if (!query) {
        throw new Error("The search_web tool requires a non-empty query string.");
      }

      const apiKey = context.searchApiKey ?? config.braveSearchApiKey;
      if (!apiKey) {
        throw new Error("Web search is not configured. Set BRAVE_SEARCH_API_KEY to use search_web.");
      }
      if (site && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(site)) {
        throw new Error("The site filter must be a valid domain name.");
      }

      const searchQuery = site ? `site:${site} ${query}` : query;
      const searchUrl = new URL("https://api.search.brave.com/res/v1/web/search");
      searchUrl.searchParams.set("q", searchQuery);
      searchUrl.searchParams.set("count", String(maxResults));

      const response = await (context.fetch ?? fetch)(searchUrl, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey
        },
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) {
        throw new Error(`Brave Search request failed with HTTP ${response.status}.`);
      }

      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null) {
        throw new Error("Brave Search returned an invalid response.");
      }
      const web = (payload as { web?: { results?: unknown } }).web;
      if (!web || !Array.isArray(web.results)) {
        throw new Error("Brave Search response did not include web results.");
      }

      const results = web.results.slice(0, maxResults).map((item: unknown) => {
        if (typeof item !== "object" || item === null) {
          throw new Error("Brave Search returned a malformed result.");
        }
        const result = item as { title?: unknown; url?: unknown; description?: unknown };
        if (typeof result.title !== "string" || typeof result.url !== "string" || typeof result.description !== "string") {
          throw new Error("Brave Search returned a malformed result.");
        }
        let source: string;
        try {
          source = new URL(result.url).hostname;
        } catch {
          throw new Error("Brave Search returned a result with an invalid URL.");
        }
        return {
          title: result.title,
          url: result.url,
          summary: result.description,
          source
        };
      });

      logger.info("search_web completed", { maxResults, resultCount: results.length, site });
      return {
        results,
        totalResults: results.length
      };
    }
    case "file_manager": {
      const operation = args.operation;
      const relativePath = typeof args.path === "string" ? args.path : "";
      const { target: targetPath } = await ensureSafePath(relativePath, operation);

      switch (operation) {
        case "list": {
          const stat = await fs.stat(targetPath).catch(() => null);
          if (stat && stat.isDirectory()) {
            const entries = await fs.readdir(targetPath);
            logger.info("file_manager list", { path: targetPath });
            return { path: targetPath, files: entries };
          }
          if (stat && stat.isFile()) {
            const parent = path.dirname(targetPath);
            const entries = await fs.readdir(parent);
            logger.info("file_manager list file parent", { path: targetPath });
            return { path: targetPath, files: entries };
          }
          throw new Error(`Path does not exist or is not accessible: ${relativePath}`);
        }
        case "read": {
          const content = await fs.readFile(targetPath, "utf8");
          logger.info("file_manager read", { path: targetPath });
          return { path: targetPath, content };
        }
        case "write": {
          const content = typeof args.content === "string" ? args.content : "";
          const directory = path.dirname(targetPath);
          await fs.mkdir(directory, { recursive: true });
          const resolvedDirectory = await fs.realpath(directory);
          if (!isWithinRoot(await fs.realpath(config.fileRoot), resolvedDirectory)) {
            throw new Error("Symbolic links outside the configured file root are not allowed.");
          }
          await fs.writeFile(targetPath, content, "utf8");
          logger.info("file_manager write", { path: targetPath, bytes: content.length });
          return { path: targetPath, created: true };
        }
        default:
          throw new Error(`Unsupported file_manager operation: ${String(operation)}`);
      }
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
