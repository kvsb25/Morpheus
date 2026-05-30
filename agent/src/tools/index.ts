import { tool } from "@langchain/core/tools";
import { Command } from "@langchain/langgraph/web";
import { z } from "zod";
import { OTLPEvent } from "../state.js";

// --- Deterministic analyst (Phase 1: the "How") ---

export const queryTracesById = tool(
  async ({ trace_id }) => {
    const tempoUrl = process.env.TEMPO_URL;

    const response = await fetch(`${tempoUrl}/api/traces/${trace_id}`);

    if (response.status === 404) {
      console.log(`Trace ${trace_id} not found in Tempo.`);
      return null;
    }

    if (!response.ok) {
      throw new Error(`Tempo API error: ${response.status} ${response.statusText}`);
    }

    const traceData = await response.json();

    const traceEvents: OTLPEvent[] = []

    for (const batch of traceData.batches) {
      for (const scopeSpan of batch.scopeSpans) {
        for (const span of scopeSpan.spans) {
          
          // If the span has events, push them to our flat array
          if (span.events && span.events.length > 0) {
            traceEvents.push(...span.events);
          }
          
        }
      }
    }

    // return traceData;
    return new Command({
      update:{
        traceEvents,
        messages: [
          {
            role: "tool",
            content: JSON.stringify(traceData),
          }
        ]
      }
    })
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
  async ({ trace_id, alertStartTimeMs }) => {

    const lokiUrl = process.env.LOKI_URL;

    // LogQL: Look in your service, parse the JSON, and match the trace_id
    // Can set service name as variable for multiple services and let the LLM decide the service
    const query = `{service_name="express-victim-service"} | json | trace_id="${trace_id}"`;

    // Define a time window (e.g., 5 minutes before and after the alert)
    // Loki requires timestamps in nanoseconds!
    const startNano = ((alertStartTimeMs - 300000) * 1000000); 
    const endNano = (Date.now() * 1000000);

    const params = new URLSearchParams({
      query: query,
      start: startNano.toString(),
      end: endNano.toString(),
      limit: "500" // Max number of logs to return
    });

    const response = await fetch(`${lokiUrl}/loki/api/v1/query_range?${params}`);
    
    if (!response.ok) {
      throw new Error(`Loki API error: ${response.status} ${response.statusText}`);
    }

    const json = await response.json();
    
    if (json.status !== "success" || !json.data.result || json.data.result.length === 0) {
      console.log(`No logs found for trace_id: ${trace_id}`);
      return [];
    }

    // Extract and format the log lines
    const logs: any[] = [];
    json.data.result.forEach((stream: {values: any[][]}) => {
      stream.values.forEach(value => {
        // value[0] is the nanosecond timestamp, value[1] is the log line string
        const logLine = JSON.parse(value[1]); 
        logs.push(logLine);
      });
    });

    return logs;
  },
  {
    name: "query_logs_by_trace",
    description:
      "Returns all application logs from Loki injected with this specific trace context.",
    schema: z.object({
      trace_id: z.string(),
      alertStartTimeMs: z.number(),
    }),
  }
);

export const queryMetrics = tool(
  async ({ metric_names, timeframe_minutes }) => {
    const vmUrl = process.env.VICTORIA_METRICS_URL;
    const serviceName = "express-victim-service";

    // Build optimized PromQL query string
    let query = `{service_name="${serviceName}"}`;
    if (metric_names && metric_names.length > 0) {
      // Uses PromQL regex matching to filter multiple metrics efficiently in one network call
      // Example: {service_name="express-victim-service", __name__=~"process_open_fds|node_event_loop_utilization"}
      const metricRegex = metric_names.join("|");
      query = `{service_name="${serviceName}", __name__=~"${metricRegex}"}`;
    }

    // Determine whether to hit the instant query or range query endpoint based on timeframe
    const isRangeQuery = typeof timeframe_minutes === "number" && timeframe_minutes > 0;
    const endpoint = isRangeQuery ? "/api/v1/query_range" : "/api/v1/query";
    
    const params = new URLSearchParams({ query });

    if (isRangeQuery && timeframe_minutes) {
      const nowInSeconds = Math.floor(Date.now() / 1000);
      const startInSeconds = nowInSeconds - (timeframe_minutes * 60);
      
      params.append("start", startInSeconds.toString());
      params.append("end", nowInSeconds.toString());
      params.append("step", "30s");
    }

    const response = await fetch(`${vmUrl}${endpoint}?${params}`);
    if (!response.ok) {
      throw new Error(`VictoriaMetrics HTTP error: ${response.statusText}`);
    }

    const json = await response.json();
    if (json.status !== "success" || !json.data || !json.data.result) {
      return { totalFound: 0, results: [] };
    }

    // 3. Sort results alphabetically by metric name
    const processedResults = json.data.result.sort((a:{metric:{__name__:string}}, b:{metric:{__name__:string}}) =>
      a.metric.__name__.localeCompare(b.metric.__name__)
    );

    return {
      totalFound: processedResults.length,
      results: processedResults
    };
  },
  {
    name: "query_metrics",
    description:
      "Queries VictoriaMetrics via PromQL for infrastructure anomalies around the incident time.",
    schema: z.object({
      metric_names: z.array(z.string()),
      timeframe_minutes: z.number(),
    }),
  }
);

// --- Interpretation (Phase 2: the "Why") ---

export const fetchRepoContext = tool(
  async ({ file_path }) => {
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/contents/${file_path}`, {
      headers: { 'Accept': 'application/vnd.github.v3.raw' }
    });
    if (!response.ok) throw new Error(response.statusText);
    return response.text();
  },
  {
    name: "fetch_repo_context",
    description:
      "Fetches source code from GitHub based on file paths in the stack trace (traceEvents).",
    schema: z.object({
      file_path: z.string(),
    }),
  }
);

export const fetchCommitHistorySince = tool(
  async ({ timestamp_iso }) => {
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/commits?since=${encodeURIComponent(timestamp_iso)}`);
    if (!response.ok) throw new Error(response.statusText);
    return response.json();
  },
  {
    name: "fetch_commit_history_since",
    description:
      "Fetches the commit history of a GitHub repository starting from a specific timestamp.",
    schema: z.object({
      timestamp_iso: z.string(),
    }),
  }
);

export const fetchFileFromCommit = tool(
  async ({ commit_sha, file_path }) => {
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}/contents/${file_path}?ref=${commit_sha}`, {
      headers: { 'Accept': 'application/vnd.github.v3.raw' }
    });
    if (!response.ok) throw new Error(response.statusText);
    return response.text();
  },
  {
    name: "fetch_file_from_commit",
    description:
      "Fetches a specific file from a given commit in the GitHub repository.",
    schema: z.object({
      commit_sha: z.string(),
      file_path: z.string(),
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

export const analystTools = [queryTracesById, queryLogsByTrace, queryMetrics];
export const interpreterTools = [fetchRepoContext, fetchCommitHistorySince, fetchFileFromCommit];
export const remediationTools = [searchRunbooks, checkCurrentCapabilities];
export const gatekeeperTools = [executeSafeScript, escalateToHumanPager];
