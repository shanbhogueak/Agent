import express from "express";
import { z } from "zod";
import { buildTools, composeInput, extractOutputText, type ComposeInputOptions } from "./agent.js";
import { executeSkillChain } from "./chain.js";
import { appConfig } from "./config.js";
import { formatRuntimeMemory, loadContextFiles } from "./context.js";
import { createMemoryStore } from "./memory.js";
import { openai } from "./openai.js";
import {
  chainRequestSchema,
  chatRequestSchema,
  memoryFeedbackSchema,
  memoryListQuerySchema,
} from "./schemas.js";
import { listLocalSkills } from "./skills.js";

const app = express();
const sessionToLastResponseId = new Map<string, string>();
const memoryStore = createMemoryStore(appConfig);

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true, memoryBackend: memoryStore.kind });
});

app.get("/v1/mcp/servers", (_req, res) => {
  res.status(200).json({
    configPath: appConfig.mcpConfigPath,
    attached: appConfig.mcpServers.map((server) => ({
      label: server.label,
      url: server.url,
      transport: server.transport ?? "unspecified",
      timeoutSeconds: server.timeoutSeconds ?? null,
      requireApproval: server.requireApproval ?? "always",
      hasAuthorization: Boolean(server.authorization || (server.label.toLowerCase() === "apify" && appConfig.apifyMcpToken)),
      headerKeys: Object.keys(server.headers ?? {}),
      allowedTools: server.allowedTools ?? [],
    })),
    skipped: appConfig.mcpSkippedServers,
  });
});

app.post("/webhooks/openai", express.raw({ type: "application/json" }), async (req, res) => {
  if (!appConfig.openaiWebhookSecret) {
    res.status(400).json({ error: "OPENAI_WEBHOOK_SECRET is not configured." });
    return;
  }

  const rawBody = (req.body as Buffer).toString("utf8");

  try {
    const event = await openai.webhooks.unwrap(rawBody, req.headers, appConfig.openaiWebhookSecret);

    if (event.type === "response.completed") {
      const response = event.data as any;
      console.log("Webhook: response.completed", {
        response_id: response?.id,
        status: response?.status,
      });
    }

    if (event.type === "response.failed") {
      const response = event.data as any;
      console.error("Webhook: response.failed", {
        response_id: response?.id,
        status: response?.status,
      });
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook signature verification failed", error);
    res.status(400).json({ error: "Invalid webhook signature." });
  }
});

app.use(express.json({ limit: "2mb" }));

app.get("/v1/context", async (_req, res) => {
  try {
    const context = await loadContextFiles(appConfig);
    res.status(200).json({
      agentContextPath: context.agentContextPath,
      memoryFilePath: context.memoryFilePath,
      hasAgentContext: context.agentContext.trim().length > 0,
      hasMemoryFileContext: context.memoryFileContext.trim().length > 0,
      memoryBackend: memoryStore.kind,
      memoryMaxContextEntries: appConfig.memoryMaxContextEntries,
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/v1/skills/local", async (_req, res) => {
  const skills = await listLocalSkills();
  res.status(200).json({ skills });
});

app.post("/v1/memory/feedback", async (req, res) => {
  try {
    const payload = memoryFeedbackSchema.parse(req.body);
    const entry = await memoryStore.add({
      content: payload.content,
      category: payload.category,
      source: payload.source ?? "feedback",
      sessionId: payload.sessionId,
      userId: payload.userId,
    });

    res.status(201).json({ entry, backend: memoryStore.kind });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/v1/memory", async (req, res) => {
  try {
    const query = memoryListQuerySchema.parse(req.query);
    const entries = await memoryStore.list({
      sessionId: query.sessionId,
      userId: query.userId,
      limit: query.limit,
    });

    res.status(200).json({
      backend: memoryStore.kind,
      count: entries.length,
      entries,
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/v1/chat", async (req, res) => {
  try {
    const payload = chatRequestSchema.parse(req.body);
    const tools = buildTools();
    const options = await buildComposeOptions(payload);
    const input = await composeInput(payload, options);

    const previousResponseId = payload.sessionId
      ? sessionToLastResponseId.get(payload.sessionId)
      : undefined;

    let usedMcpFallback = false;
    let response;
    try {
      response = await openai.responses.create({
        model: appConfig.openaiModel,
        input,
        tools,
        metadata: payload.metadata,
        tool_choice: payload.toolChoice as any,
        previous_response_id: previousResponseId,
      } as any);
    } catch (error) {
      const fallbackTools = stripMcpTools(tools);
      if (shouldRetryWithoutMcp(error, tools) && fallbackTools.length < tools.length) {
        usedMcpFallback = true;
        console.warn("Retrying /v1/chat without MCP tools due to MCP authorization failure.");
        response = await openai.responses.create({
          model: appConfig.openaiModel,
          input,
          tools: fallbackTools,
          metadata: payload.metadata,
          tool_choice: payload.toolChoice as any,
          previous_response_id: previousResponseId,
        } as any);
      } else {
        throw error;
      }
    }

    if (payload.sessionId && response.id) {
      sessionToLastResponseId.set(payload.sessionId, response.id);
    }

    res.status(200).json({
      responseId: response.id,
      outputText: extractOutputText(response),
      status: response.status,
      previousResponseId,
      warnings: usedMcpFallback ? [MCP_FALLBACK_WARNING] : [],
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/v1/chat/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const payload = chatRequestSchema.parse(req.body);
    const tools = buildTools();
    const options = await buildComposeOptions(payload);
    const input = await composeInput(payload, options);

    const previousResponseId = payload.sessionId
      ? sessionToLastResponseId.get(payload.sessionId)
      : undefined;

    let activeTools = tools;
    let usedMcpFallback = false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const stream = openai.responses.stream({
          model: appConfig.openaiModel,
          input,
          tools: activeTools,
          metadata: payload.metadata,
          tool_choice: payload.toolChoice as any,
          previous_response_id: previousResponseId,
        } as any);

        if (usedMcpFallback) {
          res.write(
            `data: ${JSON.stringify({ type: "warning", warning: MCP_FALLBACK_WARNING })}\n\n`,
          );
        }

        for await (const event of stream) {
          if (event?.type === "response.output_text.delta" && typeof event?.delta === "string") {
            res.write(`data: ${JSON.stringify({ type: "delta", delta: event.delta })}\n\n`);
          }

          if (event?.type === "error") {
            res.write(
              `data: ${JSON.stringify({ type: "error", error: event?.message ?? "Unknown stream error" })}\n\n`,
            );
          }
        }

        const finalResponse = await stream.finalResponse();

        if (payload.sessionId && finalResponse?.id) {
          sessionToLastResponseId.set(payload.sessionId, finalResponse.id);
        }

        res.write(
          `data: ${JSON.stringify({
            type: "done",
            responseId: finalResponse?.id,
            outputText: extractOutputText(finalResponse),
          })}\n\n`,
        );
        res.end();
        return;
      } catch (error) {
        const fallbackTools = stripMcpTools(activeTools);
        if (attempt === 0 && shouldRetryWithoutMcp(error, activeTools) && fallbackTools.length < activeTools.length) {
          usedMcpFallback = true;
          activeTools = fallbackTools;
          console.warn("Retrying /v1/chat/stream without MCP tools due to MCP authorization failure.");
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    res.write(`data: ${JSON.stringify({ type: "error", error: getErrorMessage(error) })}\n\n`);
    res.end();
  }
});

app.post("/v1/chat/async", async (req, res) => {
  try {
    const payload = chatRequestSchema.parse(req.body);
    const tools = buildTools();
    const options = await buildComposeOptions(payload);
    const input = await composeInput(payload, options);

    const previousResponseId = payload.sessionId
      ? sessionToLastResponseId.get(payload.sessionId)
      : undefined;

    let usedMcpFallback = false;
    let response;
    try {
      response = await openai.responses.create({
        model: appConfig.openaiModel,
        input,
        tools,
        background: true,
        metadata: payload.metadata,
        tool_choice: payload.toolChoice as any,
        previous_response_id: previousResponseId,
      } as any);
    } catch (error) {
      const fallbackTools = stripMcpTools(tools);
      if (shouldRetryWithoutMcp(error, tools) && fallbackTools.length < tools.length) {
        usedMcpFallback = true;
        console.warn("Retrying /v1/chat/async without MCP tools due to MCP authorization failure.");
        response = await openai.responses.create({
          model: appConfig.openaiModel,
          input,
          tools: fallbackTools,
          background: true,
          metadata: payload.metadata,
          tool_choice: payload.toolChoice as any,
          previous_response_id: previousResponseId,
        } as any);
      } else {
        throw error;
      }
    }

    if (payload.sessionId && response.id) {
      sessionToLastResponseId.set(payload.sessionId, response.id);
    }

    res.status(202).json({
      responseId: response.id,
      status: response.status,
      previousResponseId,
      warnings: usedMcpFallback ? [MCP_FALLBACK_WARNING] : [],
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/v1/chat/chain", async (req, res) => {
  try {
    const payload = chainRequestSchema.parse(req.body);
    const tools = buildTools();
    let usedMcpFallback = false;
    let result;

    try {
      result = await executeSkillChain(payload, {
        client: openai,
        model: appConfig.openaiModel,
        tools,
        composeInput,
        getContextOptions: async ({ sessionId, userId, skillNames }) =>
          buildComposeOptions({ sessionId, userId, skillNames }),
        getPreviousResponseId: (sessionId) =>
          sessionId ? sessionToLastResponseId.get(sessionId) : undefined,
        setPreviousResponseId: (sessionId, responseId) => {
          sessionToLastResponseId.set(sessionId, responseId);
        },
      });
    } catch (error) {
      const fallbackTools = stripMcpTools(tools);
      if (shouldRetryWithoutMcp(error, tools) && fallbackTools.length < tools.length) {
        usedMcpFallback = true;
        console.warn("Retrying /v1/chat/chain without MCP tools due to MCP authorization failure.");
        result = await executeSkillChain(payload, {
          client: openai,
          model: appConfig.openaiModel,
          tools: fallbackTools,
          composeInput,
          getContextOptions: async ({ sessionId, userId, skillNames }) =>
            buildComposeOptions({ sessionId, userId, skillNames }),
          getPreviousResponseId: (sessionId) =>
            sessionId ? sessionToLastResponseId.get(sessionId) : undefined,
          setPreviousResponseId: (sessionId, responseId) => {
            sessionToLastResponseId.set(sessionId, responseId);
          },
        });
      } else {
        throw error;
      }
    }

    res.status(200).json({
      ...result,
      warnings: usedMcpFallback ? [MCP_FALLBACK_WARNING] : [],
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/v1/chat/status/:responseId", async (req, res) => {
  try {
    const { responseId } = z.object({ responseId: z.string().min(1) }).parse(req.params);
    const response = await openai.responses.retrieve(responseId);
    res.status(200).json({
      responseId: response.id,
      status: response.status,
      outputText: extractOutputText(response),
      raw: response,
    });
  } catch (error) {
    handleError(res, error);
  }
});

void startServer();

async function startServer(): Promise<void> {
  try {
    await memoryStore.init();
  } catch (error) {
    console.error("Failed to initialize memory store", error);
    process.exit(1);
  }

  app.listen(appConfig.port, () => {
    console.log(`Agent service listening on http://localhost:${appConfig.port}`);
    console.log(`Memory backend: ${memoryStore.kind}`);

    if (appConfig.mcpServers.length > 0) {
      console.log(
        "MCP servers attached:",
        appConfig.mcpServers.map((server) => `${server.label}(${server.url})`).join(", "),
      );
    }
    if (appConfig.mcpSkippedServers.length > 0) {
      for (const skippedServer of appConfig.mcpSkippedServers) {
        console.warn(`MCP server skipped: ${skippedServer.label}. ${skippedServer.reason}`);
      }
    }
  });
}

async function buildComposeOptions(payload: {
  sessionId?: string;
  userId?: string;
  skillNames?: string[];
}): Promise<ComposeInputOptions> {
  const [contextFiles, memoryEntries] = await Promise.all([
    loadContextFiles(appConfig),
    memoryStore.list({
      sessionId: payload.sessionId,
      userId: payload.userId,
      limit: appConfig.memoryMaxContextEntries,
    }),
  ]);

  return {
    agentContext: contextFiles.agentContext,
    memoryFileContext: contextFiles.memoryFileContext,
    runtimeMemoryContext: formatRuntimeMemory(memoryEntries),
  };
}

const MCP_FALLBACK_WARNING =
  "One or more MCP servers were unavailable for this request. Retried without MCP tools. Check MCP credentials and /v1/mcp/servers.";

function stripMcpTools(tools: unknown[]): unknown[] {
  return tools.filter((tool) => !isMcpTool(tool));
}

function shouldRetryWithoutMcp(error: unknown, tools: unknown[]): boolean {
  return hasMcpTools(tools) && isMcpAuthorizationError(error);
}

function hasMcpTools(tools: unknown[]): boolean {
  return tools.some((tool) => isMcpTool(tool));
}

function isMcpTool(tool: unknown): boolean {
  return typeof tool === "object" && tool !== null && (tool as { type?: unknown }).type === "mcp";
}

function isMcpAuthorizationError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const asAny = error as {
    status?: unknown;
    message?: unknown;
    error?: { message?: unknown; type?: unknown; code?: unknown };
    code?: unknown;
    type?: unknown;
  };
  const status = typeof asAny.status === "number" ? asAny.status : undefined;
  const message = [
    typeof asAny.message === "string" ? asAny.message : "",
    typeof asAny.error?.message === "string" ? asAny.error.message : "",
  ]
    .join(" ")
    .toLowerCase();
  const errorCode = typeof asAny.code === "string" ? asAny.code.toLowerCase() : "";
  const nestedCode = typeof asAny.error?.code === "string" ? asAny.error.code.toLowerCase() : "";
  const errorType = typeof asAny.type === "string" ? asAny.type.toLowerCase() : "";
  const nestedType = typeof asAny.error?.type === "string" ? asAny.error.type.toLowerCase() : "";

  const mentionsMcp = message.includes("mcp");
  const authFailure =
    message.includes("unauthorized") ||
    message.includes("http status code: 401") ||
    message.includes("http status code: 403");
  const connectorError =
    errorCode === "http_error" ||
    nestedCode === "http_error" ||
    errorType === "external_connector_error" ||
    nestedType === "external_connector_error";

  return mentionsMcp && (authFailure || connectorError || status === 401 || status === 403 || status === 424);
}

function handleError(res: express.Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid request payload", details: error.flatten() });
    return;
  }

  console.error(error);
  res.status(500).json({ error: getErrorMessage(error) });
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}
