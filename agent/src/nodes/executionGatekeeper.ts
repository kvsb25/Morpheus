import { AIMessage } from "@langchain/core/messages";
import type { GraphStateType } from "../state.js";
import { escalateToHumanPager, executeSafeScript } from "../tools/index.js";

/**
 * Programmatic gatekeeper — no LLM. Executes only after humanApproval is set post-interrupt.
 */
export async function executionGatekeeper(
  state: GraphStateType
): Promise<Partial<GraphStateType>> {
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
