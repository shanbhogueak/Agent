import type OpenAI from "openai";
import type { ComposeInputOptions } from "./agent.js";
import { extractOutputText } from "./agent.js";
import type { ChainRequestInput } from "./schemas.js";
import type { ChatRequest } from "./types.js";

export interface ChainExecutionResult {
  plan: {
    overallStrategy: string;
    steps: Array<{ skill: string; objective: string }>;
  };
  steps: Array<{
    skill: string;
    objective: string;
    responseId?: string;
    outputText: string;
  }>;
  final: {
    responseId?: string;
    outputText: string;
  };
}

export interface ChainExecutorDeps {
  client: OpenAI;
  model: string;
  tools: unknown[];
  composeInput: (payload: ChatRequest, options?: ComposeInputOptions) => Promise<unknown[]>;
  getContextOptions: (payload: {
    sessionId?: string;
    userId?: string;
    skillNames?: string[];
  }) => Promise<ComposeInputOptions>;
  getPreviousResponseId: (sessionId?: string) => string | undefined;
  setPreviousResponseId: (sessionId: string, responseId: string) => void;
}

export async function executeSkillChain(
  request: ChainRequestInput,
  deps: ChainExecutorDeps,
): Promise<ChainExecutionResult> {
  const previousResponseId = deps.getPreviousResponseId(request.sessionId);

  const plannerContext = await deps.getContextOptions({
    sessionId: request.sessionId,
    userId: request.userId,
  });

  const plannerInput = await deps.composeInput(
    {
      input: buildPlannerPrompt(request),
      sessionId: request.sessionId,
      userId: request.userId,
      metadata: request.metadata,
      toolChoice: request.toolChoice,
    },
    plannerContext,
  );

  const plannerResponse = await deps.client.responses.create({
    model: deps.model,
    input: plannerInput,
    tools: deps.tools,
    previous_response_id: previousResponseId,
    metadata: request.metadata,
    tool_choice: request.toolChoice as any,
  } as any);

  let chainPreviousResponseId = plannerResponse.id ?? previousResponseId;
  if (request.sessionId && plannerResponse.id) {
    deps.setPreviousResponseId(request.sessionId, plannerResponse.id);
  }

  const plannerText = extractOutputText(plannerResponse);
  const plan = parsePlannerOutput(plannerText, request.skillChain, request.input);

  const stepResults: ChainExecutionResult["steps"] = [];
  let workingDraft = "";

  for (const step of plan.steps) {
    const stepContext = await deps.getContextOptions({
      sessionId: request.sessionId,
      userId: request.userId,
      skillNames: [step.skill],
    });

    const stepInput = await deps.composeInput(
      {
        input: buildStepPrompt(request.input, step.skill, step.objective, workingDraft),
        sessionId: request.sessionId,
        userId: request.userId,
        skillNames: [step.skill],
        metadata: request.metadata,
        toolChoice: request.toolChoice,
      },
      stepContext,
    );

    const stepResponse = await deps.client.responses.create({
      model: deps.model,
      input: stepInput,
      tools: deps.tools,
      metadata: request.metadata,
      tool_choice: request.toolChoice as any,
      previous_response_id: chainPreviousResponseId,
    } as any);

    if (stepResponse.id) {
      chainPreviousResponseId = stepResponse.id;
    }
    if (request.sessionId && stepResponse.id) {
      deps.setPreviousResponseId(request.sessionId, stepResponse.id);
    }

    const outputText = extractOutputText(stepResponse);
    stepResults.push({
      skill: step.skill,
      objective: step.objective,
      responseId: stepResponse.id,
      outputText,
    });

    workingDraft = appendDraft(workingDraft, step.skill, outputText);
  }

  const summaryContext = await deps.getContextOptions({
    sessionId: request.sessionId,
    userId: request.userId,
  });

  const summaryInput = await deps.composeInput(
    {
      input: buildSummaryPrompt(request.input, stepResults, request.summarizerHint),
      sessionId: request.sessionId,
      userId: request.userId,
      metadata: request.metadata,
      toolChoice: request.toolChoice,
    },
    summaryContext,
  );

  const summaryResponse = await deps.client.responses.create({
    model: deps.model,
    input: summaryInput,
    tools: deps.tools,
    metadata: request.metadata,
    tool_choice: request.toolChoice as any,
    previous_response_id: chainPreviousResponseId,
  } as any);

  if (request.sessionId && summaryResponse.id) {
    deps.setPreviousResponseId(request.sessionId, summaryResponse.id);
  }

  return {
    plan,
    steps: stepResults,
    final: {
      responseId: summaryResponse.id,
      outputText: extractOutputText(summaryResponse),
    },
  };
}

function buildPlannerPrompt(request: ChainRequestInput): string {
  const plannerHint = request.plannerHint
    ? `Planner hint: ${request.plannerHint}`
    : "No extra planner hint provided.";

  return [
    "Create a compact execution plan for a skill chain.",
    "Return strict JSON only.",
    "Schema:",
    '{"overall_strategy":"string","steps":[{"skill":"string","objective":"string"}]}',
    `Allowed skills in order: ${request.skillChain.join(", ")}`,
    plannerHint,
    `User request: ${request.input}`,
    "Use each provided skill at most once. Keep objectives concrete and action-oriented.",
  ].join("\n");
}

function buildStepPrompt(
  originalInput: string,
  skill: string,
  objective: string,
  workingDraft: string,
): string {
  return [
    `Original request: ${originalInput}`,
    `Active skill: ${skill}`,
    `Objective for this step: ${objective}`,
    workingDraft.trim().length > 0
      ? `Current working draft from previous steps:\n${workingDraft}`
      : "Current working draft: (empty)",
    "Produce output that can be consumed by the next skill in the chain.",
  ].join("\n\n");
}

function buildSummaryPrompt(
  originalInput: string,
  stepResults: ChainExecutionResult["steps"],
  summarizerHint?: string,
): string {
  const stepsBlock = stepResults
    .map(
      (step, index) =>
        `Step ${index + 1} | skill=${step.skill} | objective=${step.objective}\n${step.outputText}`,
    )
    .join("\n\n");

  return [
    `Original request: ${originalInput}`,
    summarizerHint ? `Summary hint: ${summarizerHint}` : "Summary hint: produce a concise final answer.",
    "Synthesize the final response using the step outputs below.",
    stepsBlock,
    "Include final answer first, then a short 'Trace' section showing what each skill contributed.",
  ].join("\n\n");
}

function appendDraft(current: string, skill: string, output: string): string {
  const section = [`### ${skill}`, output.trim()].join("\n");
  return current.trim().length === 0 ? section : `${current}\n\n${section}`;
}

function parsePlannerOutput(
  text: string,
  fallbackSkills: string[],
  userInput: string,
): ChainExecutionResult["plan"] {
  const fallback = {
    overallStrategy: "Execute provided skills sequentially and synthesize outputs.",
    steps: fallbackSkills.map((skill) => ({ skill, objective: userInput })),
  };

  const jsonCandidate = extractFirstJsonObject(text);
  if (!jsonCandidate) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(jsonCandidate) as {
      overall_strategy?: unknown;
      overallStrategy?: unknown;
      steps?: unknown;
    };

    if (!Array.isArray(parsed.steps)) {
      return fallback;
    }

    const steps = parsed.steps
      .map((step) => {
        const skill = typeof (step as any)?.skill === "string" ? (step as any).skill : null;
        const objective =
          typeof (step as any)?.objective === "string" ? (step as any).objective : userInput;
        if (!skill) {
          return null;
        }
        return { skill, objective };
      })
      .filter((step): step is { skill: string; objective: string } => Boolean(step));

    if (steps.length === 0) {
      return fallback;
    }

    const allowed = new Set(fallbackSkills);
    const filteredSteps = steps.filter((step) => allowed.has(step.skill));
    if (filteredSteps.length === 0) {
      return fallback;
    }

    return {
      overallStrategy:
        typeof parsed.overallStrategy === "string"
          ? parsed.overallStrategy
          : typeof parsed.overall_strategy === "string"
            ? parsed.overall_strategy
            : fallback.overallStrategy,
      steps: filteredSteps,
    };
  } catch {
    return fallback;
  }
}

function extractFirstJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return text.slice(start, end + 1);
}
