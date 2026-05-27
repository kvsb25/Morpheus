import { tool } from "@langchain/core/tools";
import { z } from "zod";

// --- Triage ---

export const fetchAlertContext = tool(
  async ({ alert_id }) => {
    return JSON.stringify({
      alert_id,
      metric_name: "node_event_loop_utilization",
      timestamp: new Date().toISOString(),
      service_name: "express-victim-service",
      severity: "critical",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      annotations: {
        summary: "Critical event loop utilization",
        agent_rca_hint:
          "Look for CPU-intensive while loops on GET /api/fault/block-loop.",
      },
      labels: {
        alertname: "EventLoopUtilizationCritical",
        service_name: "express-victim-service",
      },
    });
  },
  {
    name: "fetch_alert_context",
    description: "Fetches the raw webhook payload for a given alert ID.",
    schema: z.object({
      alert_id: z.string(),
    }),
  }
);

// --- Deterministic analyst (Phase 1: the "How") ---

export const queryTracesById = tool(
  async ({ trace_id }) => {
    return JSON.stringify({
      trace_id,
      root_span: "POST /api/fault/db-crash",
      spans: [
        {
          name: "POST /api/fault/db-crash",
          duration_ms: 312,
          status: "ERROR",
          http_status_code: 500,
        },
        {
          name: "db.query_execution",
          duration_ms: 268,
          status: "ERROR",
          attributes: {
            "db.statement": "SELECT * FROM users WHERE email = $1 FOR UPDATE NOWAIT",
            "db.system": "postgresql",
            "http.request.body.sanitized": '{"queryHint":"pool exhausted"}',
            "process.memory.rss.bytes": 89456640,
          },
          exception: "Simulated PostgreSQL failure: pool exhausted",
        },
      ],
      mechanical_chain:
        "HTTP 500 -> db.query_execution span ERROR -> simulated pool exhaustion after 250ms wait",
    });
  },
  {
    name: "query_traces_by_id",
    description:
      "Returns the distributed span tree and duration metrics from Grafana Tempo.",
    schema: z.object({
      trace_id: z.string(),
    }),
  }
);

export const queryLogsByTrace = tool(
  async ({ trace_id }) => {
    return JSON.stringify({
      trace_id,
      logs: [
        {
          timestamp: "2026-05-23T12:00:02.123Z",
          level: "error",
          message: "Database query connection timeout pool exhausted",
          trace_id,
          span_id: "00f067aa0ba902b7",
          "service.name": "express-victim-service",
          component: "database-pool",
        },
      ],
    });
  },
  {
    name: "query_logs_by_trace",
    description:
      "Returns all application logs from Loki injected with this specific trace context.",
    schema: z.object({
      trace_id: z.string(),
    }),
  }
);

export const queryMetrics = tool(
  async ({ metric_name, timeframe_minutes }) => {
    return JSON.stringify({
      metric_name,
      timeframe_minutes,
      samples: [
        { ts: "2026-05-23T11:58:00Z", value: 0.42 },
        { ts: "2026-05-23T11:59:00Z", value: 0.78 },
        { ts: "2026-05-23T12:00:00Z", value: 0.94 },
      ],
      promql_hint: `max_over_time(${metric_name}{service_name="express-victim-service"}[${timeframe_minutes}m])`,
      anomaly: "ELU spike correlates with synchronous event-loop blocking or DB fault burst",
    });
  },
  {
    name: "query_metrics",
    description:
      "Queries VictoriaMetrics via PromQL for infrastructure anomalies around the incident time.",
    schema: z.object({
      metric_name: z.string(),
      timeframe_minutes: z.number(),
    }),
  }
);

// --- Interpretation (Phase 2: the "Why") ---

export const fetchRepoContext = tool(
  async ({ file_path, function_name }) => {
    return JSON.stringify({
      file_path,
      function_name: function_name ?? "simulateDbFailure",
      snippet: `// victim-service/index.js — simulated failure path\nreject(new Error(\`Simulated PostgreSQL failure: \${hint}\`));`,
      interpretation_hint:
        "Fault-injection endpoint intentionally rejects DB operations; not a production schema bug.",
    });
  },
  {
    name: "fetch_repo_context",
    description:
      "Fetches source code snippets from GitHub based on file paths in the stack trace.",
    schema: z.object({
      file_path: z.string(),
      function_name: z.string().optional(),
    }),
  }
);

export const fetchDeploymentHistory = tool(
  async ({ timestamp_iso }) => {
    return JSON.stringify({
      timestamp_iso,
      deployments: [
        {
          id: "deploy-8821",
          service: "express-victim-service",
          version: "1.0.0",
          deployed_at: "2026-05-23T11:45:00Z",
          changed_files: ["victim-service/index.js", "victim-service/telemetry.js"],
        },
      ],
      config_changes: [],
    });
  },
  {
    name: "fetch_deployment_history",
    description:
      "Checks CI/CD for deployments or config changes immediately preceding the incident.",
    schema: z.object({
      timestamp_iso: z.string(),
    }),
  }
);

// --- Remediation ---

export const searchRunbooks = tool(
  async ({ fault_keyword }) => {
    return JSON.stringify({
      fault_keyword,
      runbooks: [
        {
          id: "rb-db-pool-exhaustion",
          title: "PostgreSQL connection pool exhaustion",
          steps: [
            "Drain traffic from affected pods",
            "Restart connection pool with bounded concurrency",
            "Validate db.query_execution error rate returns to baseline",
          ],
          approved_script: "restart_db_pool",
        },
        {
          id: "rb-event-loop-block",
          title: "Node.js event loop blocking",
          steps: ["Identify sync CPU loops", "Move work off main thread or add timeouts"],
          approved_script: "throttle_fault_endpoint",
        },
      ],
    });
  },
  {
    name: "search_runbooks",
    description:
      "Searches engineering wikis for known mitigation steps related to the fault.",
    schema: z.object({
      fault_keyword: z.string(),
    }),
  }
);

export const checkCurrentCapabilities = tool(
  async () => {
    return JSON.stringify({
      approved_scripts: [
        "restart_db_pool",
        "throttle_fault_endpoint",
        "scale_victim_service",
        "drain_fd_leak_handles",
      ],
    });
  },
  {
    name: "check_current_capabilities",
    description:
      "Returns a list of whitelist-approved script names that the Gatekeeper can execute.",
    schema: z.object({}),
  }
);

// --- Gatekeeper ---

export const executeSafeScript = tool(
  async ({ script_name, params }) => {

    // validate script and then run on terminal
    return JSON.stringify({
      status: "executed",
      script_name,
      params,
      message: `Mock execution of ${script_name} completed successfully.`,
    });
  },
  {
    name: "execute_safe_script",
    description: "Executes a pre-approved mitigation script in production.",
    schema: z.object({
      script_name: z.string(),
      params: z.record(z.any()),
    }),
  }
);

// remove this tool
export const escalateToHumanPager = tool(
  async ({ reason, severity_level }) => {
    return JSON.stringify({
      status: "escalated",
      reason,
      severity_level,
      pager: "on-call-sre",
      message: `Mock pager fired at ${severity_level}.`,
    });
  },
  {
    name: "escalate_to_human_pager",
    description:
      "Pages the on-call SRE when an automated fix is unavailable or rejected.",
    schema: z.object({
      reason: z.string(),
      severity_level: z.enum(["SEV-1", "SEV-2", "SEV-3"]),
    }),
  }
);

export const triageTools = [fetchAlertContext];
export const analystTools = [queryTracesById, queryLogsByTrace, queryMetrics];
export const interpreterTools = [fetchRepoContext, fetchDeploymentHistory];
export const remediationTools = [searchRunbooks, checkCurrentCapabilities];
export const gatekeeperTools = [executeSafeScript, escalateToHumanPager];
