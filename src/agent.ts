import { appConfig } from "./config.js";
import { loadSkillInstructions } from "./skills.js";
import type { ChatRequest } from "./types.js";

export interface ComposeInputOptions {
  agentContext?: string;
  memoryFileContext?: string;
  runtimeMemoryContext?: string;
  extraDeveloperContext?: string[];
}

export function buildTools(): unknown[] {
  const tools: unknown[] = [];
  const apifyToken = appConfig.apifyMcpToken?.trim();

  for (const server of appConfig.mcpServers) {
    const headers: Record<string, string> = { ...(server.headers ?? {}) };
    if (
      server.label.toLowerCase() === "apify" &&
      apifyToken &&
      !server.authorization &&
      !headers.Authorization
    ) {
      headers.Authorization = `Bearer ${apifyToken}`;
    }

    const mcpTool: Record<string, unknown> = {
      type: "mcp",
      server_label: server.label,
      server_url: server.url,
      server_description: server.description ?? `MCP tools from ${server.label}`,
      require_approval: server.requireApproval ?? "always",
    };

    if (server.authorization) {
      mcpTool.authorization = server.authorization;
    }
    if (Object.keys(headers).length > 0) {
      mcpTool.headers = headers;
    }
    if (server.allowedTools && server.allowedTools.length > 0) {
      mcpTool.allowed_tools = server.allowedTools;
    }

    tools.push(mcpTool);
  }

  if (appConfig.enableWebSearch) {
    tools.push({ type: "web_search" });
  }

  if (appConfig.skillRefs.length > 0) {
    tools.push({
      type: "shell",
      environment: {
        type: "container",
        skills: appConfig.skillRefs.map((skill) => ({
          type: "skill_reference",
          skill_id: skill.skill_id,
          version: skill.version ?? "latest",
        })),
      },
    });
  }

  return tools;
}

export async function composeInput(
  payload: ChatRequest,
  options: ComposeInputOptions = {},
): Promise<unknown[]> {
  const skillNames = payload.skillNames ?? [];
  const skillContext = skillNames.length > 0 ? await loadSkillInstructions(skillNames) : "";

  const contextBlocks = [
    {
      label: "Precedence Rules",
      content: [
        "Apply instruction precedence in this order:",
        "1) Platform safety and hard policies.",
        "2) Persistent agent role/context instructions from agents.md/AGENTS.md.",
        "3) Persistent memory preferences from memory.md and memory store.",
        "4) Skill instructions (SKILL.md bundles).",
        "5) Current user request.",
        "When instructions conflict at the same precedence level, prefer the most specific instruction.",
      ].join("\n"),
    },
    {
      label: "Persistent Agent Context",
      content: options.agentContext ?? "",
    },
    {
      label: "Persistent Memory File",
      content: options.memoryFileContext ?? "",
    },
    {
      label: "Runtime Memory",
      content: options.runtimeMemoryContext ?? "",
    },
    {
      label: "Skill Context",
      content: skillContext,
    },
    ...((options.extraDeveloperContext ?? []).map((content, index) => ({
      label: `Extra Context ${index + 1}`,
      content,
    })) as Array<{ label: string; content: string }>),
  ].filter((block) => block.content.trim().length > 0);

  const developerMessages = contextBlocks.map((block) => ({
    role: "developer",
    content: [{ type: "input_text", text: `# ${block.label}\n\n${block.content}` }],
  }));

  const userMessages = normalizeUserInput(payload.input);
  return [...developerMessages, ...userMessages];
}

export function extractOutputText(response: any): string {
  if (typeof response?.output_text === "string") {
    return response.output_text;
  }

  if (Array.isArray(response?.output)) {
    const chunks = response.output
      .flatMap((entry: any) => entry?.content ?? [])
      .filter((content: any) => content?.type === "output_text" && typeof content?.text === "string")
      .map((content: any) => content.text);

    if (chunks.length > 0) {
      return chunks.join("\n");
    }
  }

  return "";
}

function normalizeUserInput(input: string | unknown[]): unknown[] {
  if (typeof input === "string") {
    return [
      {
        role: "user",
        content: [{ type: "input_text", text: input }],
      },
    ];
  }

  if (Array.isArray(input)) {
    return input;
  }

  return [
    {
      role: "user",
      content: [{ type: "input_text", text: String(input ?? "") }],
    },
  ];
}
