import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { GraphState, type GraphStateType } from "./state.js";
import { hasPendingToolCalls } from "./utils/messages.js";
import {
  deterministicAnalyst,
  finalizeDeterministicAnalysis,
  finalizeInterpretation,
  finalizeProposedAction,
  interpretationAgent,
  rcaReviewer,
  remediationAgent,
} from "./nodes/agentNodes.js";
import { executionGatekeeper } from "./nodes/executionGatekeeper.js";
import {
  analystTools,
  interpreterTools,
  remediationTools,
} from "./tools/index.js";

const analystToolNode = new ToolNode(analystTools, {handleToolErrors: true});
const interpreterToolNode = new ToolNode(interpreterTools, {handleToolErrors: true});
const remediationToolNode = new ToolNode(remediationTools, {handleToolErrors: true});

function routeAfterAnalyst(state: GraphStateType): "analyst_tools" | "finalize_deterministic" {
  return hasPendingToolCalls(state.messages) ? "analyst_tools" : "finalize_deterministic";
}

function routeAfterInterpreter(state: GraphStateType): "interpreter_tools" | "finalize_interpretation" {
  return hasPendingToolCalls(state.messages) ? "interpreter_tools" : "finalize_interpretation";
}

function routeAfterRemediation(state: GraphStateType): "remediation_tools" | "finalize_remediation" {
  return hasPendingToolCalls(state.messages) ? "remediation_tools" : "finalize_remediation";
}

function isReviewApproved(feedback: string | null): boolean {
  if (!feedback) {
    return false;
  }
  return /\bAPPROVED\b/i.test(feedback);
}

function needsFreshTelemetry(feedback: string | null): boolean {
  if (!feedback) {
    return false;
  }
  const lower = feedback.toLowerCase();
  return (
    lower.includes("telemetry") ||
    lower.includes("trace") ||
    lower.includes("metric") ||
    lower.includes("tempo") ||
    lower.includes("loki")
  );
}

/**
 * Reasoning loop: APPROVED or revision cap -> remediation; else reinterpret or re-query telemetry.
 */
export function routeAfterReviewer(
  state: GraphStateType
): "remediationAgent" | "interpretationAgent" | "deterministicAnalyst" {
  if (isReviewApproved(state.reviewFeedback) || state.revisionCount >= 3) {
    return "remediationAgent";
  }
  if (needsFreshTelemetry(state.reviewFeedback)) {
    return "deterministicAnalyst";
  }
  return "interpretationAgent";
}

const workflow = new StateGraph(GraphState)
  // .addNode("triage_tools", triageToolNode)
  .addNode("deterministicAnalyst", deterministicAnalyst)
  .addNode("analyst_tools", analystToolNode)
  .addNode("finalize_deterministic", finalizeDeterministicAnalysis)
  .addNode("interpretationAgent", interpretationAgent)
  .addNode("interpreter_tools", interpreterToolNode)
  .addNode("finalize_interpretation", finalizeInterpretation)
  .addNode("rcaReviewer", rcaReviewer)
  .addNode("remediationAgent", remediationAgent)
  .addNode("remediation_tools", remediationToolNode)
  .addNode("finalize_remediation", finalizeProposedAction)
  .addNode("executionGatekeeper", executionGatekeeper)
  .addEdge(START, "deterministicAnalyst")
  // .addConditionalEdges("triageAgent", routeAfterTriage, ["triage_tools", "deterministicAnalyst"])
  // .addEdge("triage_tools", "triageAgent")
  .addConditionalEdges("deterministicAnalyst", routeAfterAnalyst, [
    "analyst_tools",
    "finalize_deterministic",
  ])
  .addEdge("analyst_tools", "deterministicAnalyst")
  .addEdge("finalize_deterministic", "interpretationAgent")
  .addConditionalEdges("interpretationAgent", routeAfterInterpreter, [
    "interpreter_tools",
    "finalize_interpretation",
  ])
  .addEdge("interpreter_tools", "interpretationAgent")
  .addEdge("finalize_interpretation", "rcaReviewer")
  .addConditionalEdges("rcaReviewer", routeAfterReviewer, [
    "remediationAgent",
    "interpretationAgent",
    "deterministicAnalyst",
  ])
  .addConditionalEdges("remediationAgent", routeAfterRemediation, [
    "remediation_tools",
    "finalize_remediation",
  ])
  .addEdge("remediation_tools", "remediationAgent")
  .addEdge("finalize_remediation", "executionGatekeeper")
  .addEdge("executionGatekeeper", END);

const checkpointer = new MemorySaver();

export const rcaGraph = workflow.compile({
  checkpointer,
  // Human reviews proposedAction after remediation; graph resumes into executionGatekeeper.
  interruptAfter: ["finalize_remediation"],
});

export { checkpointer };
