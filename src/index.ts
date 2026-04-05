import { createRequire } from "module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initConfig } from "./config.js";
import { paperlessTools } from "./tools/paperless.js";
import { ragTools } from "./tools/rag.js";
import { log } from "./logger.js";

// Crash detection
process.on("uncaughtException", (err) => {
  log("error", `[CRASH] Uncaught exception: ${err.message}\n${err.stack}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log("error", `[CRASH] Unhandled rejection: ${reason}`);
});

process.on("exit", (code) => {
  log("info", `[PROCESS] Exiting with code ${code}`);
});

process.on("SIGTERM", () => {
  log("info", `[PROCESS] Received SIGTERM`);
});

process.on("SIGINT", () => {
  log("info", `[PROCESS] Received SIGINT`);
});

// Read package.json for name and version
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { name: string; version: string };

// Validate config at startup before registering tools
initConfig();

const server = new Server(
  {
    name: pkg.name,
    version: pkg.version,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register all tools
const allTools = [...paperlessTools, ...ragTools];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: allTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = allTools.find((t) => t.name === request.params.name);

  if (!tool) {
    return {
      content: [
        {
          type: "text",
          text: `Tool "${request.params.name}" not found`,
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await tool.handler(request.params.arguments ?? {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("paperless-rag-mcp server started");
}

main().catch(console.error);
