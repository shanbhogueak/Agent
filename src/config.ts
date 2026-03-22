import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import {
  getDefaultAgentContextCandidates,
} from "./context.js";
import type { AppConfig, McpServerConfig, McpSkippedServer, SkillRefConfig } from "./types.js";

loadDotenv();

const mcpServerSchema: z.ZodType<McpServerConfig> = z.object({
  label: z.string().min(1),
  url: z.string().url(),
  description: z.string().optional(),
  requireApproval: z.enum(["always", "never"]).optional(),
  transport: z.enum(["http", "sse"]).optional(),
  timeoutSeconds: z.number().positive().optional(),
});

const mcpServerFileEntrySchema = z.object({
  url: z.string().url().optional(),
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  transport: z.enum(["http", "sse"]).optional(),
  timeout_seconds: z.number().positive().optional(),
  description: z.string().optional(),
  require_approval: z.enum(["always", "never"]).optional(),
  requireApproval: z.enum(["always", "never"]).optional(),
});

const mcpConfigFileSchema = z.object({
  mcpServers: z.record(z.string().min(1), mcpServerFileEntrySchema),
});

const skillRefSchema: z.ZodType<SkillRefConfig> = z.object({
  skill_id: z.string().min(1),
  version: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
});

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_MODEL: z.string().default("gpt-5.4"),
  OPENAI_WEBHOOK_SECRET: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  MCP_SERVERS_JSON: z.string().default("[]"),
  MCP_CONFIG_PATH: z.string().default("./mcp.config.json"),
  SKILL_REFS_JSON: z.string().default("[]"),
  ENABLE_WEB_SEARCH: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  AGENT_CONTEXT_PATHS: z
    .string()
    .default(getDefaultAgentContextCandidates().join(",")),
  MEMORY_FILE_PATH: z.string().default("./memory.md"),
  MEMORY_BACKEND: z.enum(["none", "file", "redis", "postgres"]).default("file"),
  MEMORY_STORE_FILE_PATH: z.string().default("./memory.store.jsonl"),
  MEMORY_MAX_CONTEXT_ENTRIES: z.coerce.number().int().positive().default(20),
  REDIS_URL: z.string().optional(),
  POSTGRES_URL: z.string().optional(),
});

function parseJsonArray<T>(name: string, value: string, itemSchema: z.ZodType<T>): T[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }

  return z.array(itemSchema).parse(parsed);
}

function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function loadMcpConfigFile(configPath: string): {
  servers: McpServerConfig[];
  skipped: McpSkippedServer[];
} {
  const resolvedPath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(process.cwd(), configPath);

  if (!fs.existsSync(resolvedPath)) {
    return { servers: [], skipped: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  } catch {
    throw new Error(`MCP config file is not valid JSON: ${resolvedPath}`);
  }

  const fileConfig = mcpConfigFileSchema.parse(parsed);
  const servers: McpServerConfig[] = [];
  const skipped: McpSkippedServer[] = [];

  for (const [label, entry] of Object.entries(fileConfig.mcpServers)) {
    if (entry.url) {
      servers.push({
        label,
        url: entry.url,
        description: entry.description,
        requireApproval: entry.requireApproval ?? entry.require_approval,
        transport: entry.transport,
        timeoutSeconds: entry.timeout_seconds,
      });
      continue;
    }

    if (entry.command) {
      skipped.push({
        label,
        reason:
          "Command-based MCP servers are not directly attachable via Responses API tools. Expose this MCP server at an HTTP/SSE URL and use that URL instead.",
      });
      continue;
    }

    skipped.push({
      label,
      reason: "Missing both 'url' and 'command' in MCP server config.",
    });
  }

  return { servers, skipped };
}

function mergeMcpServers(...serverLists: McpServerConfig[][]): McpServerConfig[] {
  const merged = new Map<string, McpServerConfig>();
  for (const list of serverLists) {
    for (const server of list) {
      merged.set(server.label, server);
    }
  }
  return Array.from(merged.values());
}

const env = envSchema.parse(process.env);
const envMcpServers = parseJsonArray("MCP_SERVERS_JSON", env.MCP_SERVERS_JSON, mcpServerSchema);
const fileMcp = loadMcpConfigFile(env.MCP_CONFIG_PATH);

export const appConfig: AppConfig = {
  port: env.PORT,
  openaiApiKey: env.OPENAI_API_KEY,
  openaiModel: env.OPENAI_MODEL,
  openaiWebhookSecret: env.OPENAI_WEBHOOK_SECRET,
  enableWebSearch: env.ENABLE_WEB_SEARCH,
  mcpConfigPath: env.MCP_CONFIG_PATH,
  agentContextPathCandidates: parseCommaList(env.AGENT_CONTEXT_PATHS),
  memoryFilePath: env.MEMORY_FILE_PATH,
  memoryBackend: env.MEMORY_BACKEND,
  memoryStoreFilePath: env.MEMORY_STORE_FILE_PATH,
  memoryMaxContextEntries: env.MEMORY_MAX_CONTEXT_ENTRIES,
  redisUrl: env.REDIS_URL,
  postgresUrl: env.POSTGRES_URL,
  mcpServers: mergeMcpServers(envMcpServers, fileMcp.servers),
  mcpSkippedServers: fileMcp.skipped,
  skillRefs: parseJsonArray("SKILL_REFS_JSON", env.SKILL_REFS_JSON, skillRefSchema),
};
