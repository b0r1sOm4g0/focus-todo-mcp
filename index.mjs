#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadAllData } from "./reader.mjs";
import { READ_TOOL_DEFINITIONS, createReadHandlers } from "./read-tools.mjs";

// ── Data cache ────────────────────────────────────────────────────────────────

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 30_000; // 30s

function getData() {
  if (!cache || Date.now() - cacheTime > CACHE_TTL) {
    cache = loadAllData();
    cacheTime = Date.now();
  }
  return cache;
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "focus-todo", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOL_DEFINITIONS = [...READ_TOOL_DEFINITIONS];
const handlers = { ...createReadHandlers({ getData }) };

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = handlers[name];
  let result;

  try {
    if (!handler) throw new Error(`Unknown tool: ${name}`);
    result = await handler(args ?? {});
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }

  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: "text", text }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
