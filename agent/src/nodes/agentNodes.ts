// import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai"
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import {RCA_REVIEWER_OUTPUT_SCHEMA} from "../utils/outputSchemas.js";
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

// function createModell() {
//   return new ChatOpenAI({
//     model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
//     temperature: 0,
//   });
// }

function createModel(){
  return new ChatGoogleGenerativeAI({
    model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
    temperature: 0,
    apiKey: process.env.GEMINI_API_KEY,
    // Default is 6. On a 429 that turns one logical call into six requests with
    // backoff, which keeps the rate limit alive instead of letting it clear.
    maxRetries: 2,
  });
}

/**
 * Serializes every Gemini call and spaces them by GEMINI_MIN_INTERVAL_MS.
 *
 * The graph's three tool loops (analyst, interpreter, remediation) issue their
 * calls back to back with no delay, which bursts well past the free-tier RPM
 * within a single incident. Calls queue on one promise chain, so concurrent
 * nodes wait their turn rather than firing in parallel.
 */
const GEMINI_MIN_INTERVAL_MS = Number.parseInt(
  process.env.GEMINI_MIN_INTERVAL_MS ?? "7000",
  10
);

let geminiQueue: Promise<unknown> = Promise.resolve();
let lastGeminiCallStartedAt = 0;

function throttleGemini<T>(fn: () => Promise<T>): Promise<T> {
  const run = geminiQueue.then(async () => {
    const waitMs = lastGeminiCallStartedAt + GEMINI_MIN_INTERVAL_MS - Date.now();
    if (waitMs > 0) {
      console.log(`[sre-agent] throttling Gemini call — waiting ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastGeminiCallStartedAt = Date.now();
    return fn();
  });

  // Keep the chain alive even if this call rejects, so one failure does not
  // wedge every later call behind a permanently rejected promise.
  geminiQueue = run.catch(() => undefined);
  return run;
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
  
  const response = await throttleGemini(() =>
    model.invoke([new SystemMessage(fullSystemPrompt), ...state.messages])
  );
  return { messages: [response] };
}

export async function deterministicAnalyst(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {

  const { analystTools } = await import("../tools/index.js");

  const feedbackNote = state.reviewFeedback
    ? `\n### ⚠️ Reviewer Feedback\n${state.reviewFeedback.logicalLeap ?? null}\n${state.reviewFeedback.requiredCorrection?.forDeterministicAnalyst ?? null}\n\n*Directive: You MUST incorporate this feedback to correct or refine your previous hypothesis.*`
    : "";
  
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
    
    ${feedbackNote}

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
  
  const incidentContext = state.incident 
    ? `\n### Incident Context\n- Alert ID: ${state.incident.alertId}\n- Metric: ${state.incident.metricName}\n- Timestamp: ${state.incident.timestamp}\n` 
    : "";

  const feedbackNote = state.reviewFeedback
    ? `\n### ⚠️ Reviewer Feedback\n${state.reviewFeedback.logicalLeap ?? null}\n${state.reviewFeedback.requiredCorrection?.forInterpretationAgent ?? null}\n\n*Directive: You MUST incorporate this feedback to correct or refine your previous hypothesis.*\n`
    : "";

  const invocationPrompt = `
    Initiating Phase 2 RCA: Systemic Interpretation.

    ### Phase 1: Deterministic Analysis (The "How")
    The Deterministic Analyst has established the following mechanical root cause. Accept this as objective fact:
    ${state.deterministicAnalysis}
    ${incidentContext}${feedbackNote}
    ### Task
    Using your tools, query the repository and deployment history to uncover the systemic "Why" behind this failure. Output your final synthesis clearly divided into **Code-Level Root Cause** and **Process-Level Root Cause**.
  `.trim();
  
  const result = await invokeLLM(
    INTERPRETATION_SYSTEM_PROMPT,
    interpreterTools,
    state,
    invocationPrompt
  );
  
  return result;
}
// Some changes are made in the graph flow (which are minute) and they will be visible from the old invocation prompt above make sure while forming the prompt remember those also

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
  const baseModel = createModel();
  const model = baseModel.withStructuredOutput(RCA_REVIEWER_OUTPUT_SCHEMA)
  const response = await throttleGemini(() =>
    model.invoke([
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
    ])
  );

  return {
    messages: [new AIMessage(String(response.logicalLeap))],
    reviewFeedback: response,
    revisionCount: state.revisionCount + 1,
  };
}

// make the remediation process autonomuos
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

// later: validate the code for syntax (the remediation to be executed)
// later: add edge from this node to remediationAgent to inform it on syntax error
export async function finalizeProposedAction(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  const content = getLastAiMessageContent(state.messages);
  const parsed = extractProposedAction(content);
  const fallbackAction = {
    scriptName: "restart_db_pool",
    params: { service: "express-victim-service" },
    reasoning:
      content ||
      "Default mitigation — remediation agent did not return structured JSON action.",
  }
  
  return {
    proposedAction: parsed ?? fallbackAction,
  };
}

/*
 * Programmatic gatekeeper — no LLM. Executes only after humanApproval is set post-interrupt.
 */
export async function executionGatekeeper(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
  
  const { escalateToHumanPager, executeSafeScript } = await import("../tools/index.js")
  const { humanApproval, proposedAction } = state;

  if (humanApproval === "approved" && proposedAction) {
    const result = await executeSafeScript.invoke({
      script_name: proposedAction.scriptName,
      params: proposedAction.params,
    });
    return {
      messages: [
        new AIMessage({
          content: `Gatekeeper executed approved script.\n${String(result)}`,
        }),
      ],
    };
  }

  const reason =
    humanApproval === "rejected"
      ? "Human rejected the proposed remediation."
      : humanApproval === "escalated"
        ? "Human escalated without automated execution."
        : "Automated remediation unavailable or not approved.";

  const severity =
    state.incident?.metricName === "node_event_loop_utilization" ? "SEV-1" : "SEV-2";

  const result = await escalateToHumanPager.invoke({
    reason: `${reason} Proposed: ${proposedAction?.scriptName ?? "none"}.`,
    severity_level: severity,
  });

  return {
    messages: [
      new AIMessage({
        content: `Gatekeeper escalated to on-call.\n${String(result)}`,
      }),
    ],
  };
}