import { fileURLToPath } from "node:url";
import { HumanMessage } from "@langchain/core/messages";
import { rcaGraph } from "./graph.js";

export { rcaGraph } from "./graph.js";
export { GraphState, type GraphStateType } from "./state.js";
export * from "./tools/index.js";

export type VmalertWebhookPayload = {
  alerts?: Array<{
    fingerprint?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    startsAt?: string;
  }>;
};

/**
 * Entry point for vmalert -> Alertmanager -> agent webhook.
 * Runs triage through remediation, then pauses before executionGatekeeper for human approval.
 */
export async function runIncidentFromWebhook(
  payload: VmalertWebhookPayload,
  threadId: string
): Promise<unknown> {
  const alert = payload.alerts?.[0];
  const alertId = alert?.fingerprint ?? alert?.labels?.alertname ?? "unknown-alert";
  const metricName = alert?.labels?.metric_name ?? alert?.labels?.alertname ?? "unknown-metric";
  const timestamp = alert?.startsAt ?? new Date().toISOString();

  const initial = await rcaGraph.invoke(
    {
      messages: [
        new HumanMessage(
          JSON.stringify({
            source: "vmalert",
            alertId,
            metricName,
            timestamp,
            labels: alert?.labels ?? {},
            annotations: alert?.annotations ?? {},
          })
        ),
      ],
      incident: { alertId, metricName, timestamp },
    },
    { configurable: { thread_id: threadId } }
  );

  return initial;
}

/**
 * Resume after human-in-the-loop: set humanApproval then continue to executionGatekeeper.
 */
export async function resumeAfterHumanReview(
  threadId: string,
  humanApproval: "approved" | "rejected" | "escalated"
): Promise<unknown> {
  return rcaGraph.invoke(
    { humanApproval },
    { configurable: { thread_id: threadId } }
  );
}

async function main() {
  const threadId = process.env.INCIDENT_THREAD_ID ?? `incident-${Date.now()}`;

  const mockWebhook: VmalertWebhookPayload = {
    alerts: [
      {
        fingerprint: "evt-loop-critical-001",
        labels: {
          alertname: "EventLoopUtilizationCritical",
          service_name: "express-victim-service",
          metric_name: "node_event_loop_utilization",
          severity: "critical",
        },
        annotations: {
          summary: "Critical event loop utilization on express-victim-service",
          agent_rca_hint: "Check GET /api/fault/block-loop",
        },
        startsAt: new Date().toISOString(),
      },
    ],
  };

  console.log(`[agent] Starting RCA workflow (thread=${threadId})`);
  const paused = await runIncidentFromWebhook(mockWebhook, threadId);
  console.log("[agent] Paused before executionGatekeeper — awaiting humanApproval");
  console.log(JSON.stringify(paused, null, 2));

  const resumed = await resumeAfterHumanReview(threadId, "approved");
  console.log("[agent] Workflow complete after human approval");
  console.log(JSON.stringify(resumed, null, 2));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
