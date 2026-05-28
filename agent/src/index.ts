import { fileURLToPath } from "node:url";
import { HumanMessage } from "@langchain/core/messages";
import { rcaGraph } from "./graph.js";
import { sendSlackIncidentAlert } from "./utils/slack.js"
import { GraphStateType } from "./state.js"

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
): Promise<GraphStateType> {
  const alert = payload.alerts?.[0];
  const alertId = alert?.fingerprint ?? alert?.labels?.alertname ?? "unknown-alert";
  const metricName = alert?.labels?.metric_name ?? alert?.labels?.alertname ?? "unknown-metric";
  const timestamp = alert?.startsAt ?? new Date().toISOString();
  const traceId = await getTraceIdFromAlert(alert);

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
      traceId,
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
): Promise<GraphStateType> {
  const config = { configurable: { thread_id: threadId } }

  // resume graph from where it was interrupted
  await rcaGraph.updateState(
    config, 
    { humanApproval }, 
    "finalize_remediation" // This ensures executionGatekeeper can read it seamlessly
  );

  return rcaGraph.invoke(
    null,
    config
  );
}

export async function sendNotiForHumanApproval( threadId: string, pauseState: GraphStateType): Promise<void>{
  
  // send proposed action with the notification

  const {messages, ...notiData} = pauseState;
  const channelId = process.env.SLACK_CHANNEL_ID ?? "testchannel";

  await sendSlackIncidentAlert(channelId, threadId, notiData)
  
}

type Alert = { fingerprint?: string | undefined; labels?: Record<string, string> | undefined; annotations?: Record<string, string> | undefined; startsAt?: string | undefined; } | undefined; 
// get traceId from VictoriaMetrics exemplar API using alert labels
async function getTraceIdFromAlert(alert: Alert): Promise<string | null> {
  
  const metricName = alert?.labels?.metric_name;
  const serviceName = alert?.labels?.service_name;
  
  if (!metricName) {
    console.log("No metric_name label on this alert. Cannot query exemplars.");
    return null;
  }

  const query = `${metricName}{service_name="${serviceName}"}`;

  const end = String(Math.floor(Date.now() / 1000));
  const start = String(Math.floor(new Date(alert?.startsAt as string).getTime() / 1000) - 60); // 1 min before it fired

  const params = new URLSearchParams({ query, start, end });

  // 4. Fetch from VictoriaMetrics
  const response = await fetch(`${process.env.VICTORIA_METRICS_URL}/api/v1/query_exemplars?${params}`);
  const json = await response.json();

  for (const series of (json.data || [])) {
    for (const exemplar of series.exemplars) {
      if (exemplar.labels && exemplar.labels.trace_id) {
        return exemplar.labels.trace_id;
      }
    }
  }
  return null;
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

  const approval = "approved" /*await sendNotiForHumanApproval(threadId, paused);*/
  const resumed = await resumeAfterHumanReview(threadId, approval);
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
