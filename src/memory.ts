import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createClient, type RedisClientType } from "redis";
import type { AppConfig, MemoryCreateInput, MemoryEntry, MemoryListQuery } from "./types.js";

export interface MemoryStore {
  kind: AppConfig["memoryBackend"];
  init(): Promise<void>;
  add(input: MemoryCreateInput): Promise<MemoryEntry>;
  list(query: MemoryListQuery): Promise<MemoryEntry[]>;
}

export function createMemoryStore(config: AppConfig): MemoryStore {
  switch (config.memoryBackend) {
    case "postgres":
      if (!config.postgresUrl) {
        throw new Error("MEMORY_BACKEND is postgres but POSTGRES_URL is not configured.");
      }
      return new PostgresMemoryStore(config.postgresUrl);
    case "redis":
      if (!config.redisUrl) {
        throw new Error("MEMORY_BACKEND is redis but REDIS_URL is not configured.");
      }
      return new RedisMemoryStore(config.redisUrl);
    case "file":
      return new FileMemoryStore(config.memoryStoreFilePath);
    case "none":
      return new NoopMemoryStore();
    default:
      return new NoopMemoryStore();
  }
}

class NoopMemoryStore implements MemoryStore {
  kind: AppConfig["memoryBackend"] = "none";

  async init(): Promise<void> {
    return;
  }

  async add(input: MemoryCreateInput): Promise<MemoryEntry> {
    return {
      id: randomUUID(),
      content: input.content,
      category: input.category,
      source: input.source,
      sessionId: input.sessionId,
      userId: input.userId,
      createdAt: new Date().toISOString(),
    };
  }

  async list(_query: MemoryListQuery): Promise<MemoryEntry[]> {
    return [];
  }
}

class FileMemoryStore implements MemoryStore {
  kind: AppConfig["memoryBackend"] = "file";

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    const resolved = resolvePath(this.filePath);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    try {
      await fs.access(resolved);
    } catch {
      await fs.writeFile(resolved, "", "utf8");
    }
  }

  async add(input: MemoryCreateInput): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: randomUUID(),
      content: input.content,
      category: input.category,
      source: input.source,
      sessionId: input.sessionId,
      userId: input.userId,
      createdAt: new Date().toISOString(),
    };

    const resolved = resolvePath(this.filePath);
    await fs.appendFile(resolved, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  async list(query: MemoryListQuery): Promise<MemoryEntry[]> {
    const resolved = resolvePath(this.filePath);
    let content = "";
    try {
      content = await fs.readFile(resolved, "utf8");
    } catch {
      return [];
    }

    const parsed = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as MemoryEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is MemoryEntry => Boolean(entry));

    return parsed
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .filter((entry) => matchesScope(entry, query))
      .slice(0, query.limit);
  }
}

class RedisMemoryStore implements MemoryStore {
  kind: AppConfig["memoryBackend"] = "redis";
  private readonly client: RedisClientType;
  private readonly listKey = "agent:memory:entries";

  constructor(redisUrl: string) {
    this.client = createClient({ url: redisUrl });
  }

  async init(): Promise<void> {
    if (!this.client.isOpen) {
      await this.client.connect();
    }
  }

  async add(input: MemoryCreateInput): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: randomUUID(),
      content: input.content,
      category: input.category,
      source: input.source,
      sessionId: input.sessionId,
      userId: input.userId,
      createdAt: new Date().toISOString(),
    };

    await this.client.lPush(this.listKey, JSON.stringify(entry));
    return entry;
  }

  async list(query: MemoryListQuery): Promise<MemoryEntry[]> {
    const scanCount = Math.max(query.limit * 8, 200);
    const rawEntries = await this.client.lRange(this.listKey, 0, scanCount - 1);

    const parsed = rawEntries
      .map((raw) => {
        try {
          return JSON.parse(raw) as MemoryEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is MemoryEntry => Boolean(entry));

    return parsed.filter((entry) => matchesScope(entry, query)).slice(0, query.limit);
  }
}

class PostgresMemoryStore implements MemoryStore {
  kind: AppConfig["memoryBackend"] = "postgres";
  private readonly pool: Pool;

  constructor(postgresUrl: string) {
    this.pool = new Pool({ connectionString: postgresUrl });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_memory (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NULL,
        source TEXT NULL,
        session_id TEXT NULL,
        user_id TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS idx_agent_memory_created_at ON agent_memory (created_at DESC)",
    );
    await this.pool.query(
      "CREATE INDEX IF NOT EXISTS idx_agent_memory_scope ON agent_memory (session_id, user_id)",
    );
  }

  async add(input: MemoryCreateInput): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: randomUUID(),
      content: input.content,
      category: input.category,
      source: input.source,
      sessionId: input.sessionId,
      userId: input.userId,
      createdAt: new Date().toISOString(),
    };

    await this.pool.query(
      `
      INSERT INTO agent_memory (id, content, category, source, session_id, user_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
      `,
      [
        entry.id,
        entry.content,
        entry.category ?? null,
        entry.source ?? null,
        entry.sessionId ?? null,
        entry.userId ?? null,
        entry.createdAt,
      ],
    );

    return entry;
  }

  async list(query: MemoryListQuery): Promise<MemoryEntry[]> {
    const values: Array<string | number> = [];
    const conditions: string[] = [];

    if (query.sessionId) {
      values.push(query.sessionId);
      conditions.push(`(session_id IS NULL OR session_id = $${values.length})`);
    } else {
      conditions.push("session_id IS NULL");
    }

    if (query.userId) {
      values.push(query.userId);
      conditions.push(`(user_id IS NULL OR user_id = $${values.length})`);
    } else {
      conditions.push("user_id IS NULL");
    }

    values.push(query.limit);

    const sql = `
      SELECT id, content, category, source, session_id, user_id, created_at
      FROM agent_memory
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${values.length}
    `;

    const result = await this.pool.query(sql, values);

    return result.rows.map((row) => ({
      id: String(row.id),
      content: String(row.content),
      category: row.category ? String(row.category) : undefined,
      source: row.source ? String(row.source) : undefined,
      sessionId: row.session_id ? String(row.session_id) : undefined,
      userId: row.user_id ? String(row.user_id) : undefined,
      createdAt: new Date(row.created_at as string | Date).toISOString(),
    }));
  }
}

function matchesScope(entry: MemoryEntry, query: MemoryListQuery): boolean {
  const sessionMatch = query.sessionId
    ? entry.sessionId === query.sessionId || entry.sessionId === undefined
    : entry.sessionId === undefined;

  const userMatch = query.userId
    ? entry.userId === query.userId || entry.userId === undefined
    : entry.userId === undefined;

  return sessionMatch && userMatch;
}

function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(process.cwd(), filePath);
}
