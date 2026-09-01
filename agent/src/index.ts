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
  const metricName = alert?.labels?.metric_name ?? "unknown-metric";
  const alertName = alert?.labels?.alertname ?? "unknown-alertname";
  const timestamp = alert?.startsAt ?? new Date().toISOString();
  const traceId = await getTraceIdFromAlert(alert);

  const initial = await rcaGraph.invoke(
    {
      messages: [
        new HumanMessage(
          JSON.stringify({
            source: "vmalert",
            alertId,
            alertName,
            metricName,
            timestamp,
            labels: alert?.labels ?? {},
            annotations: alert?.annotations ?? {},
          })
        ),
      ],
      incident: { alertId, alertName, metricName, timestamp },
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

/**
 * DEMO / PRESENTATION PATH — NOT the real RCA workflow.
 *
 * Enabled only when DEMO_MODE=true. This deliberately does NOT invoke rcaGraph:
 * it waits out a short scripted delay and then posts the same Slack approval card
 * a real run would produce, proposing the flush_pg_connections.sh mitigation.
 * Nothing here queries telemetry, calls Gemini, or reasons about the incident.
 *
 * It exists so the human-in-the-loop step can be demonstrated while the Gemini
 * free-tier quota is exhausted. With DEMO_MODE unset, runIncidentFromWebhook and
 * the full graph run exactly as before.
 */
export async function runDemoIncident(
  payload: VmalertWebhookPayload,
  threadId: string
): Promise<GraphStateType> {
  const alert = payload.alerts?.[0];
  const stepDelayMs = Number.parseInt(process.env.DEMO_STEP_DELAY_MS ?? "3000", 10);
  const pause = () => new Promise((resolve) => setTimeout(resolve, stepDelayMs));

  const incident = {
    alertId: alert?.fingerprint ?? alert?.labels?.alertname ?? "unknown-alert",
    alertName: alert?.labels?.alertname ?? "unknown-alertname",
    metricName: alert?.labels?.metric_name ?? "unknown-metric",
    timestamp: alert?.startsAt ?? new Date().toISOString(),
  };

  console.log("[sre-agent] DEMO_MODE — simulated run, RCA graph NOT invoked");
  console.log("[agent] Phase 1: deterministic analysis");
  await pause();
  console.log("[agent] Phase 2: systemic interpretation");
  await pause();
  console.log("[agent] RCA review passed — drafting remediation");
  await pause();
  console.log("[agent] Paused before executionGatekeeper — awaiting humanApproval");

  return {
    messages: [],
    incident,
    traceId: null,
    traceEvents: null,
    deterministicAnalysis:
      "Connection pool saturated: active connections reached max (10/10); " +
      "db.query_execution spans returned timeouts under NOWAIT lock contention.",
    interpretation:
      "Requests acquire pool connections that are never released on the error path, " +
      "so the pool drains under sustained traffic and every later query times out.",
    reviewFeedback: null,
    revisionCount: 1,
    proposedAction: {
      scriptName: "flush_pg_connections.sh",
      params: { service: "express-victim-service" },
      reasoning:
        "Flush idle/leaked PostgreSQL connections to release the exhausted pool and " +
        "restore query capacity for express-victim-service.",
    },
    humanApproval: "pending",
  };
}

// send proposed action with the notification
export async function sendNotiForHumanApproval( threadId: string, pauseState: GraphStateType): Promise<void>{

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
