export type ApprovalMode = "always" | "never";

export interface McpServerConfig {
  label: string;
  url: string;
  description?: string;
  requireApproval?: ApprovalMode;
  transport?: "http" | "sse";
  timeoutSeconds?: number;
  authorization?: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
}

export interface SkillRefConfig {
  skill_id: string;
  version?: number | "latest";
}

export interface McpSkippedServer {
  label: string;
  reason: string;
}

export interface AppConfig {
  port: number;
  openaiApiKey: string;
  openaiModel: string;
  openaiWebhookSecret?: string;
  enableWebSearch: boolean;
  mcpConfigPath?: string;
  agentContextPathCandidates: string[];
  memoryFilePath: string;
  memoryBackend: "none" | "file" | "redis" | "postgres";
  memoryStoreFilePath: string;
  memoryMaxContextEntries: number;
  redisUrl?: string;
  postgresUrl?: string;
  apifyMcpToken?: string;
  mcpServers: McpServerConfig[];
  mcpSkippedServers: McpSkippedServer[];
  skillRefs: SkillRefConfig[];
}

export interface ChatRequest {
  input: string | unknown[];
  sessionId?: string;
  userId?: string;
  skillNames?: string[];
  metadata?: Record<string, unknown>;
  toolChoice?: unknown;
}

export interface MemoryEntry {
  id: string;
  content: string;
  category?: string;
  source?: string;
  sessionId?: string;
  userId?: string;
  createdAt: string;
}

export interface MemoryCreateInput {
  content: string;
  category?: string;
  source?: string;
  sessionId?: string;
  userId?: string;
}

export interface MemoryListQuery {
  sessionId?: string;
  userId?: string;
  limit: number;
}
