import { ChatOpenAI } from "@langchain/openai";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { GraphStateType } from "../state.js";
import {
  DETERMINISTIC_ANALYST_SYSTEM_PROMPT,
  INTERPRETATION_SYSTEM_PROMPT,
  RCA_REVIEWER_SYSTEM_PROMPT,
  REMEDIATION_SYSTEM_PROMPT,
} from "./prompts.js";
import {
  extractIncidentFromMessages,
  extractProposedAction,
  extractTraceIdFromMessages,
  getLastAiMessageContent,
} from "../utils/messages.js";

function createModel() {
  return new ChatOpenAI({
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    temperature: 0,
  });
}

function buildContextMessage(state: GraphStateType): string {
  return [
    `incident: ${JSON.stringify(state.incident)}`,
    `traceId: ${state.traceId}`,
    `deterministicAnalysis: ${state.deterministicAnalysis}`,
    `interpretation: ${state.interpretation}`,
    `reviewFeedback: ${state.reviewFeedback}`,
    `revisionCount: ${state.revisionCount}`,
    `proposedAction: ${JSON.stringify(state.proposedAction)}`,
    `humanApproval: ${state.humanApproval}`,
  ].join("\n");
}

async function invokeLLM(
  systemPrompt: string,
  tools: StructuredToolInterface[],
  state: GraphStateType,
  extraHuman?: string
): Promise<Partial<GraphStateType>> {

  const baseModel = createModel();
  const model = tools.length > 0 ? baseModel.bindTools(tools) : baseModel;
  const humanContent = extraHuman ?? buildContextMessage(state);
  const fullSystemPrompt = `${systemPrompt}\n\n### CURRENT TASK CONTEXT:\n${humanContent}`;
  
  const response = await model.invoke([
    new SystemMessage(fullSystemPrompt),
    ...state.messages,
  ]);
  return { messages: [new AIMessage(response)] };
}

export async function deterministicAnalyst(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {

  const { analystTools } = await import("../tools/index.js");
  
  const invocationPrompt = `Execute Phase 1: Deterministic Analysis.

    Incident Context:
    - Alert ID: ${state.incident?.alertId}
    - Alert Name: ${state.incident?.alertName}
    - Metric Name: ${state.incident?.metricName}
    - Timestamp: ${state.incident?.timestamp}
    - Trace ID: ${state.traceId}

    Directive:
    1. Use your tools to query telemetry (logs, metrics, traces) anchored around the provided timestamp and Trace ID.
    2. Trace the state changes backward from the alert trigger to the lowest-level technical fault.
    3. Output a step-by-step mechanical failure chain.

  Stop exactly there. Do not interpret the "why" or propose fixes.`

  const result = await invokeLLM(
    DETERMINISTIC_ANALYST_SYSTEM_PROMPT,
    analystTools,
    state,
    invocationPrompt
  );
  return result;
}

export async function finalizeDeterministicAnalysis(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const content = getLastAiMessageContent(state.messages);
  return {
    deterministicAnalysis:
      content ||
      "Mechanical chain unavailable — analyst did not produce a final summary message.",
  };
}

export async function interpretationAgent(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const { interpreterTools } = await import("../tools/index.js");
  const feedbackNote = state.reviewFeedback
    ? `\nReviewer feedback to address:\n${state.reviewFeedback}`
    : "";
  const result = await invokeLLM(
    INTERPRETATION_SYSTEM_PROMPT,
    interpreterTools,
    state,
    `Phase 2 RCA — interpret the deterministic analysis.\n${state.deterministicAnalysis}${feedbackNote}`
  );
  return result;
}

export async function finalizeInterpretation(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const content = getLastAiMessageContent(state.messages);
  return {
    interpretation:
      content ||
      "Interpretation unavailable — agent did not produce a final systemic hypothesis.",
  };
}

export async function rcaReviewer(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const model = createModel();
  const response = await model.invoke([
    new SystemMessage(RCA_REVIEWER_SYSTEM_PROMPT),
    new HumanMessage(
      [
        "Evaluate alignment between Phase 1 (deterministic) and Phase 2 (interpretation).",
        `revisionCount: ${state.revisionCount}`,
        "--- deterministicAnalysis ---",
        state.deterministicAnalysis ?? "(missing)",
        "--- interpretation ---",
        state.interpretation ?? "(missing)",
        "Respond with APPROVED or a detailed critique.",
      ].join("\n\n")
    ),
  ]);

  const feedback =
    typeof response.content === "string" ? response.content : JSON.stringify(response.content);

  return {
    messages: [response as AIMessage],
    reviewFeedback: feedback,
    revisionCount: state.revisionCount + 1,
  };
}

export async function remediationAgent(state: GraphStateType): Promise<Partial<GraphStateType>> {
  const { remediationTools } = await import("../tools/index.js");
  const result = await invokeLLM(
    REMEDIATION_SYSTEM_PROMPT,
    remediationTools,
    state,
    `Validated interpretation:\n${state.interpretation}\nPropose mitigation with scriptName, params, reasoning JSON.`
  );
  return result;
}

export async function finalizeProposedAction(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const content = getLastAiMessageContent(state.messages);
  const parsed = extractProposedAction(content);
  return {
    proposedAction: parsed ?? {
      scriptName: "restart_db_pool",
      params: { service: "express-victim-service" },
      reasoning:
        content ||
        "Default mitigation — remediation agent did not return structured JSON action.",
    },
  };
}
