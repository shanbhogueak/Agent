import express from "express";
import { randomUUID } from "node:crypto";
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
  a2aListTasksQuerySchema,
  a2aSendMessageSchema,
  a2aTaskIdParamSchema,
  memoryFeedbackSchema,
  memoryListQuerySchema,
} from "./schemas.js";
import { listLocalSkills } from "./skills.js";

const app = express();
const sessionToLastResponseId = new Map<string, string>();
const memoryStore = createMemoryStore(appConfig);
const a2aTaskRecords = new Map<string, A2aTaskRecord>();

interface A2aTaskRecord {
  taskId: string;
  responseId?: string;
  contextId?: string;
  status: string;
  outputText?: string;
  errorMessage?: string;
  warnings?: string[];
  createdAt: string;
  updatedAt: string;
}

interface AgentCardPayload {
  name: string;
  description: string;
  url: string;
  version: string;
  provider: {
    organization: string;
    url: string;
  };
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
    extendedAgentCard: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  supportedInterfaces: Array<{
    url: string;
    protocolBinding: string;
    protocolVersion: string;
  }>;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
    inputModes: string[];
    outputModes: string[];
    examples: string[];
  }>;
}

app.get("/healthz", (_req, res) => {
  res.status(200).json({
    ok: true,
    memoryBackend: memoryStore.kind,
    llmProvider: appConfig.openaiProvider,
  });
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

app.get("/.well-known/agent-card.json", async (req, res) => {
  try {
    const agentCard = await buildAgentCard(req);
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("ETag", `W/"${agentCard.version}-${agentCard.skills.length}"`);
    res.status(200).json(agentCard);
  } catch (error) {
    handleA2aError(res, error);
  }
});

app.get("/.well-known/agent-card", async (req, res) => {
  try {
    const agentCard = await buildAgentCard(req);
    res.status(200).json(agentCard);
  } catch (error) {
    handleA2aError(res, error);
  }
});

app.get("/extendedAgentCard", async (req, res) => {
  try {
    const agentCard = await buildAgentCard(req);
    res.status(200).json(agentCard);
  } catch (error) {
    handleA2aError(res, error);
  }
});

app.post("/message\\:send", async (req, res) => {
  try {
    const payload = a2aSendMessageSchema.parse(req.body);
    const normalized = normalizeA2aRequest(payload);
    const tools = buildTools();
    const options = await buildComposeOptions({
      sessionId: normalized.contextId,
      userId: normalized.userId,
      skillNames: normalized.skillNames,
    });
    const input = await composeInput(
      {
        input: normalized.inputText,
        sessionId: normalized.contextId,
        userId: normalized.userId,
        skillNames: normalized.skillNames,
        metadata: normalized.metadata,
        toolChoice: normalized.toolChoice,
      },
      options,
    );
    const previousResponseId =
      normalized.previousTaskId ??
      (normalized.contextId ? sessionToLastResponseId.get(normalized.contextId) : undefined);

    const background = payload.configuration?.blocking === false;
    const createResult = await createResponseWithMcpFallback({
      input,
      metadata: normalized.metadata,
      previousResponseId,
      toolChoice: normalized.toolChoice,
      tools,
      background,
    });
    const response = createResult.response;
    const taskId = response.id ?? `task_${randomUUID()}`;
    const outputText = extractOutputText(response);

    if (normalized.contextId && response.id) {
      sessionToLastResponseId.set(normalized.contextId, response.id);
    }

    upsertA2aTaskRecord({
      taskId,
      responseId: response.id,
      contextId: normalized.contextId,
      status: response.status ?? "completed",
      outputText,
      warnings: createResult.usedMcpFallback ? [MCP_FALLBACK_WARNING] : [],
    });

    res.status(200).json({
      task: toA2aTask({
        taskId,
        status: response.status ?? "completed",
        contextId: normalized.contextId,
        outputText,
        warnings: createResult.usedMcpFallback ? [MCP_FALLBACK_WARNING] : [],
      }),
    });
  } catch (error) {
    handleA2aError(res, error);
  }
});

app.post("/message\\:stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const payload = a2aSendMessageSchema.parse(req.body);
    const normalized = normalizeA2aRequest(payload);
    const taskId = `task_${randomUUID()}`;
    const tools = buildTools();
    const options = await buildComposeOptions({
      sessionId: normalized.contextId,
      userId: normalized.userId,
      skillNames: normalized.skillNames,
    });
    const input = await composeInput(
      {
        input: normalized.inputText,
        sessionId: normalized.contextId,
        userId: normalized.userId,
        skillNames: normalized.skillNames,
        metadata: normalized.metadata,
        toolChoice: normalized.toolChoice,
      },
      options,
    );
    const previousResponseId =
      normalized.previousTaskId ??
      (normalized.contextId ? sessionToLastResponseId.get(normalized.contextId) : undefined);

    upsertA2aTaskRecord({
      taskId,
      contextId: normalized.contextId,
      status: "queued",
      outputText: "",
    });
    writeSse(res, {
      task: toA2aTask({
        taskId,
        status: "queued",
        contextId: normalized.contextId,
      }),
    });

    let activeTools = tools;
    let usedMcpFallback = false;
    let accumulated = "";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const stream = openai.responses.stream({
          model: appConfig.openaiModel,
          input,
          tools: activeTools,
          metadata: normalized.metadata,
          tool_choice: normalized.toolChoice as any,
          previous_response_id: previousResponseId,
        } as any);

        if (usedMcpFallback) {
          writeSse(res, {
            statusUpdate: {
              taskId,
              status: {
                state: "TASK_STATE_WORKING",
                message: {
                  role: "ROLE_AGENT",
                  parts: [{ text: MCP_FALLBACK_WARNING }],
                },
                timestamp: new Date().toISOString(),
              },
            },
          });
        }

        for await (const event of stream) {
          if (event?.type === "response.output_text.delta" && typeof event?.delta === "string") {
            accumulated += event.delta;
            upsertA2aTaskRecord({
              taskId,
              contextId: normalized.contextId,
              status: "in_progress",
              outputText: accumulated,
            });
            writeSse(res, {
              artifactUpdate: {
                taskId,
                artifact: {
                  name: "output_text_delta",
                  parts: [{ text: event.delta }],
                },
              },
            });
          }

          if (event?.type === "error") {
            throw new Error(event.message ?? "Unknown stream error");
          }
        }

        const finalResponse = await stream.finalResponse();
        const outputText = extractOutputText(finalResponse) || accumulated;

        if (normalized.contextId && finalResponse?.id) {
          sessionToLastResponseId.set(normalized.contextId, finalResponse.id);
        }

        upsertA2aTaskRecord({
          taskId,
          responseId: finalResponse?.id,
          contextId: normalized.contextId,
          status: finalResponse?.status ?? "completed",
          outputText,
          warnings: usedMcpFallback ? [MCP_FALLBACK_WARNING] : [],
        });

        writeSse(res, {
          task: toA2aTask({
            taskId,
            status: finalResponse?.status ?? "completed",
            contextId: normalized.contextId,
            outputText,
            responseId: finalResponse?.id,
            warnings: usedMcpFallback ? [MCP_FALLBACK_WARNING] : [],
          }),
        });
        res.end();
        return;
      } catch (error) {
        const fallbackTools = stripMcpTools(activeTools);
        if (attempt === 0 && shouldRetryWithoutMcp(error, activeTools) && fallbackTools.length < activeTools.length) {
          usedMcpFallback = true;
          activeTools = fallbackTools;
          continue;
        }

        upsertA2aTaskRecord({
          taskId,
          contextId: normalized.contextId,
          status: "failed",
          outputText: accumulated,
          errorMessage: getErrorMessage(error),
        });
        writeSse(res, {
          task: toA2aTask({
            taskId,
            status: "failed",
            contextId: normalized.contextId,
            outputText: accumulated,
            errorMessage: getErrorMessage(error),
          }),
        });
        res.end();
        return;
      }
    }
  } catch (error) {
    writeSse(res, {
      error: {
        code: 400,
        message: getErrorMessage(error),
      },
    });
    res.end();
  }
});

app.get("/tasks/:id", async (req, res) => {
  try {
    const { id } = a2aTaskIdParamSchema.parse(req.params);
    const taskRecord = a2aTaskRecords.get(id);

    if (!taskRecord && !id.startsWith("resp_")) {
      sendA2aError(res, 404, "TASK_NOT_FOUND", `Task '${id}' was not found.`);
      return;
    }

    let currentRecord = taskRecord;
    const responseId = taskRecord?.responseId ?? (id.startsWith("resp_") ? id : undefined);

    if (responseId) {
      try {
        const response = await openai.responses.retrieve(responseId);
        const outputText = extractOutputText(response);
        const nextRecord = upsertA2aTaskRecord({
          taskId: id,
          responseId,
          contextId: taskRecord?.contextId,
          status: response.status ?? taskRecord?.status ?? "in_progress",
          outputText: outputText || taskRecord?.outputText,
        });
        currentRecord = nextRecord;
      } catch {
        // Fall back to locally tracked state if retrieval fails.
      }
    }

    if (!currentRecord) {
      sendA2aError(res, 404, "TASK_NOT_FOUND", `Task '${id}' was not found.`);
      return;
    }

    res.status(200).json({
      task: toA2aTask({
        taskId: currentRecord.taskId,
        status: currentRecord.status,
        contextId: currentRecord.contextId,
        outputText: currentRecord.outputText,
        errorMessage: currentRecord.errorMessage,
        responseId: currentRecord.responseId,
        warnings: currentRecord.warnings,
      }),
    });
  } catch (error) {
    handleA2aError(res, error);
  }
});

app.get("/tasks", (req, res) => {
  try {
    const query = a2aListTasksQuerySchema.parse(req.query);
    const tasks = Array.from(a2aTaskRecords.values())
      .filter((record) => (query.contextId ? record.contextId === query.contextId : true))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, query.pageSize)
      .map((record) =>
        toA2aTask({
          taskId: record.taskId,
          status: record.status,
          contextId: record.contextId,
          outputText: record.outputText,
          errorMessage: record.errorMessage,
          responseId: record.responseId,
          warnings: record.warnings,
        }),
      );

    res.status(200).json({
      tasks,
      nextPageToken: null,
    });
  } catch (error) {
    handleA2aError(res, error);
  }
});

app.post("/tasks/:id\\:cancel", async (req, res) => {
  try {
    const { id } = a2aTaskIdParamSchema.parse(req.params);
    const record = a2aTaskRecords.get(id);
    const responseId = record?.responseId ?? (id.startsWith("resp_") ? id : undefined);

    if (!responseId) {
      sendA2aError(
        res,
        400,
        "INVALID_TASK_STATE",
        "This task cannot be cancelled yet because no provider task ID has been assigned.",
      );
      return;
    }

    const cancelled = await openai.responses.cancel(responseId);
    const outputText = extractOutputText(cancelled) || record?.outputText || "";
    const nextRecord = upsertA2aTaskRecord({
      taskId: id,
      responseId,
      contextId: record?.contextId,
      status: cancelled.status ?? "cancelled",
      outputText,
    });

    res.status(200).json({
      task: toA2aTask({
        taskId: nextRecord.taskId,
        status: nextRecord.status,
        contextId: nextRecord.contextId,
        outputText: nextRecord.outputText,
        responseId: nextRecord.responseId,
      }),
    });
  } catch (error) {
    handleA2aError(res, error);
  }
});

app.post("/tasks/:id\\:subscribe", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const { id } = a2aTaskIdParamSchema.parse(req.params);
    let lastDigest = "";

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const snapshot = await getA2aTaskSnapshot(id);
      if (!snapshot) {
        writeSse(res, {
          error: {
            code: 404,
            message: `Task '${id}' was not found.`,
          },
        });
        res.end();
        return;
      }

      const digest = JSON.stringify({
        state: snapshot.status,
        outputText: snapshot.outputText,
        errorMessage: snapshot.errorMessage,
      });

      if (digest !== lastDigest) {
        writeSse(res, {
          task: toA2aTask({
            taskId: snapshot.taskId,
            status: snapshot.status,
            contextId: snapshot.contextId,
            outputText: snapshot.outputText,
            errorMessage: snapshot.errorMessage,
            responseId: snapshot.responseId,
            warnings: snapshot.warnings,
          }),
        });
        lastDigest = digest;
      }

      if (isTerminalOpenAiStatus(snapshot.status)) {
        res.end();
        return;
      }

      await sleep(1000);
    }

    res.end();
  } catch (error) {
    writeSse(res, {
      error: {
        code: 400,
        message: getErrorMessage(error),
      },
    });
    res.end();
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
    console.log(`LLM provider: ${appConfig.openaiProvider}`);

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

async function buildAgentCard(req: express.Request): Promise<AgentCardPayload> {
  const baseUrl = getRequestBaseUrl(req);
  const localSkills = await listLocalSkills();

  return {
    name: "MCP Skills Agent Service",
    description:
      "An A2A-compatible agent surface over OpenAI Responses API with MCP connectors, skill context, and runtime memory.",
    url: baseUrl,
    version: "1.0.0",
    provider: {
      organization: "Agent Service",
      url: baseUrl,
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
      extendedAgentCard: true,
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    supportedInterfaces: [
      {
        url: baseUrl,
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
      },
    ],
    skills: localSkills.map((skillName) => ({
      id: skillName,
      name: skillName,
      description: `Local skill '${skillName}' loaded from skills/${skillName}/SKILL.md`,
      tags: ["local-skill"],
      inputModes: ["text/plain", "application/json"],
      outputModes: ["text/plain", "application/json"],
      examples: [`Use the ${skillName} skill for this request.`],
    })),
  };
}

function getRequestBaseUrl(req: express.Request): string {
  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || `localhost:${appConfig.port}`;
  return `${protocol}://${host}`;
}

function normalizeA2aRequest(payload: z.infer<typeof a2aSendMessageSchema>): {
  inputText: string;
  contextId?: string;
  previousTaskId?: string;
  userId?: string;
  skillNames?: string[];
  metadata?: Record<string, unknown>;
  toolChoice?: unknown;
} {
  const metadata = {
    ...(asRecord(payload.metadata) ?? {}),
    ...(asRecord(payload.message.metadata) ?? {}),
  };
  const inputText = extractA2aInputText(payload.message.parts);

  if (inputText.trim().length === 0) {
    throw new Error("A2A message must include at least one text-compatible part.");
  }

  const contextId =
    (typeof payload.message.contextId === "string" ? payload.message.contextId : undefined) ??
    (typeof payload.contextId === "string" ? payload.contextId : undefined);
  const previousTaskId =
    (typeof payload.message.taskId === "string" ? payload.message.taskId : undefined) ??
    (typeof payload.taskId === "string" ? payload.taskId : undefined);
  const userId = typeof metadata.userId === "string" ? metadata.userId : undefined;
  const skillNames = normalizeSkillNames(metadata.skillNames);
  const toolChoice = metadata.toolChoice;

  return {
    inputText,
    contextId,
    previousTaskId,
    userId,
    skillNames,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    toolChoice,
  };
}

function normalizeSkillNames(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const names = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return names.length > 0 ? names : undefined;
  }

  if (typeof value === "string") {
    const names = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return names.length > 0 ? names : undefined;
  }

  return undefined;
}

function extractA2aInputText(parts: unknown[]): string {
  const normalizedParts = parts
    .map((part) => normalizeA2aPart(part))
    .map((part) => part.trim())
    .filter(Boolean);
  return normalizedParts.join("\n\n");
}

function normalizeA2aPart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }

  if (!part || typeof part !== "object") {
    return String(part ?? "");
  }

  const asAny = part as Record<string, unknown>;
  if (typeof asAny.text === "string") {
    return asAny.text;
  }
  if (typeof asAny.content === "string" && asAny.type === "text") {
    return asAny.content;
  }
  if (typeof asAny.data === "string") {
    return asAny.data;
  }

  return safeJsonStringify(part);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

async function createResponseWithMcpFallback(params: {
  input: unknown[];
  tools: unknown[];
  metadata?: Record<string, unknown>;
  toolChoice?: unknown;
  previousResponseId?: string;
  background?: boolean;
}): Promise<{ response: any; usedMcpFallback: boolean }> {
  let usedMcpFallback = false;

  try {
    const response = await openai.responses.create({
      model: appConfig.openaiModel,
      input: params.input,
      tools: params.tools,
      metadata: params.metadata,
      tool_choice: params.toolChoice as any,
      previous_response_id: params.previousResponseId,
      background: params.background,
    } as any);

    return { response, usedMcpFallback };
  } catch (error) {
    const fallbackTools = stripMcpTools(params.tools);
    if (shouldRetryWithoutMcp(error, params.tools) && fallbackTools.length < params.tools.length) {
      usedMcpFallback = true;
      const response = await openai.responses.create({
        model: appConfig.openaiModel,
        input: params.input,
        tools: fallbackTools,
        metadata: params.metadata,
        tool_choice: params.toolChoice as any,
        previous_response_id: params.previousResponseId,
        background: params.background,
      } as any);

      return { response, usedMcpFallback };
    }

    throw error;
  }
}

function upsertA2aTaskRecord(input: {
  taskId: string;
  responseId?: string;
  contextId?: string;
  status: string;
  outputText?: string;
  errorMessage?: string;
  warnings?: string[];
}): A2aTaskRecord {
  const existing = a2aTaskRecords.get(input.taskId);
  const nextRecord: A2aTaskRecord = {
    taskId: input.taskId,
    responseId: input.responseId ?? existing?.responseId,
    contextId: input.contextId ?? existing?.contextId,
    status: input.status,
    outputText: input.outputText ?? existing?.outputText,
    errorMessage: input.errorMessage ?? existing?.errorMessage,
    warnings: input.warnings ?? existing?.warnings,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  a2aTaskRecords.set(input.taskId, nextRecord);
  return nextRecord;
}

async function getA2aTaskSnapshot(taskId: string): Promise<A2aTaskRecord | null> {
  const existing = a2aTaskRecords.get(taskId);
  const responseId = existing?.responseId ?? (taskId.startsWith("resp_") ? taskId : undefined);

  if (!responseId) {
    return existing ?? null;
  }

  try {
    const response = await openai.responses.retrieve(responseId);
    return upsertA2aTaskRecord({
      taskId,
      responseId,
      contextId: existing?.contextId,
      status: response.status ?? existing?.status ?? "in_progress",
      outputText: extractOutputText(response) || existing?.outputText,
      errorMessage: existing?.errorMessage,
      warnings: existing?.warnings,
    });
  } catch {
    return existing ?? null;
  }
}

function toA2aTask(input: {
  taskId: string;
  status: string;
  contextId?: string;
  outputText?: string;
  errorMessage?: string;
  responseId?: string;
  warnings?: string[];
}): Record<string, unknown> {
  const state = toA2aTaskState(input.status);
  const statusText =
    input.errorMessage && input.errorMessage.trim().length > 0 ? input.errorMessage : input.outputText;
  const taskStatus: Record<string, unknown> = {
    state,
    timestamp: new Date().toISOString(),
  };

  if (statusText && statusText.trim().length > 0) {
    taskStatus.message = {
      role: "ROLE_AGENT",
      parts: [{ text: statusText }],
    };
  }

  const task: Record<string, unknown> = {
    id: input.taskId,
    status: taskStatus,
  };
  if (input.contextId) {
    task.contextId = input.contextId;
  }

  if (input.outputText && isTerminalOpenAiStatus(input.status)) {
    task.artifacts = [
      {
        name: "final_response",
        parts: [{ text: input.outputText }],
      },
    ];
  }

  const metadata: Record<string, unknown> = {};
  if (input.responseId) {
    metadata.responseId = input.responseId;
  }
  if (input.warnings && input.warnings.length > 0) {
    metadata.warnings = input.warnings;
  }
  if (Object.keys(metadata).length > 0) {
    task.metadata = metadata;
  }

  return task;
}

function toA2aTaskState(status: string): string {
  switch (status) {
    case "queued":
      return "TASK_STATE_SUBMITTED";
    case "in_progress":
      return "TASK_STATE_WORKING";
    case "completed":
      return "TASK_STATE_COMPLETED";
    case "failed":
      return "TASK_STATE_FAILED";
    case "cancelled":
      return "TASK_STATE_CANCELED";
    case "incomplete":
      return "TASK_STATE_FAILED";
    default:
      return "TASK_STATE_WORKING";
  }
}

function isTerminalOpenAiStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "incomplete";
}

function writeSse(res: express.Response, payload: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function handleA2aError(res: express.Response, error: unknown): void {
  if (error instanceof z.ZodError) {
    sendA2aError(res, 400, "INVALID_REQUEST", "Invalid A2A request payload.", {
      details: JSON.stringify(error.flatten()),
    });
    return;
  }

  const message = getErrorMessage(error);
  sendA2aError(res, 500, "INTERNAL_ERROR", message);
}

function sendA2aError(
  res: express.Response,
  statusCode: number,
  reason: string,
  message: string,
  metadata?: Record<string, string>,
): void {
  const details = {
    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
    reason,
    domain: "a2a-protocol.org",
    metadata: metadata ?? {},
  };

  res.status(statusCode).json({
    error: {
      code: statusCode,
      status: toHttpStatusName(statusCode),
      message,
      details: [details],
    },
  });
}

function toHttpStatusName(statusCode: number): string {
  switch (statusCode) {
    case 400:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "ABORTED";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 500:
      return "INTERNAL";
    case 503:
      return "UNAVAILABLE";
    default:
      return "UNKNOWN";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
