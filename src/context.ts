import { promises as fs } from "node:fs";
import path from "node:path";
import type { AppConfig, MemoryEntry } from "./types.js";

export interface LoadedContext {
  agentContextPath: string | null;
  agentContext: string;
  memoryFilePath: string | null;
  memoryFileContext: string;
}

const DEFAULT_AGENT_CONTEXT_CANDIDATES = ["./agents.md", "./AGENTS.md", "./claude.md", "./CLAUDE.md"];

export async function loadContextFiles(config: AppConfig): Promise<LoadedContext> {
  const agentContextPath = await resolveFirstExistingPath(config.agentContextPathCandidates);
  const memoryFilePath = await resolveFirstExistingPath([config.memoryFilePath]);

  const [agentContext, memoryFileContext] = await Promise.all([
    readFileIfExists(agentContextPath),
    readFileIfExists(memoryFilePath),
  ]);

  return {
    agentContextPath,
    agentContext,
    memoryFilePath,
    memoryFileContext,
  };
}

export function getDefaultAgentContextCandidates(): string[] {
  return [...DEFAULT_AGENT_CONTEXT_CANDIDATES];
}

export function formatRuntimeMemory(entries: MemoryEntry[]): string {
  if (entries.length === 0) {
    return "";
  }

  const lines = entries.map((entry) => {
    const metadata: string[] = [];
    if (entry.category) {
      metadata.push(`category=${entry.category}`);
    }
    if (entry.source) {
      metadata.push(`source=${entry.source}`);
    }
    if (entry.sessionId) {
      metadata.push(`session=${entry.sessionId}`);
    }
    if (entry.userId) {
      metadata.push(`user=${entry.userId}`);
    }

    const suffix = metadata.length > 0 ? ` (${metadata.join(", ")})` : "";
    return `- ${entry.content}${suffix}`;
  });

  return [
    "Persistent runtime memory entries (latest first):",
    ...lines,
  ].join("\n");
}

async function resolveFirstExistingPath(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const resolved = resolvePath(candidate);
    try {
      await fs.access(resolved);
      return resolved;
    } catch {
      continue;
    }
  }

  return null;
}

async function readFileIfExists(filePath: string | null): Promise<string> {
  if (!filePath) {
    return "";
  }

  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(process.cwd(), filePath);
}
