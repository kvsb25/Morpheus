const fs = require("fs");
const os = require("os");
const path = require("path");
const v8 = require("v8");
const winston = require("winston");
const Transport = require("winston-transport");
const { context, trace, metrics, logs, SpanStatusCode } = require("@opentelemetry/api");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { Resource } = require("@opentelemetry/resources");
const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPMetricExporter } = require("@opentelemetry/exporter-metrics-otlp-http");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { PeriodicExportingMetricReader } = require("@opentelemetry/sdk-metrics");
const { LoggerProvider, BatchLogRecordProcessor } = require("@opentelemetry/sdk-logs");
const { monitorEventLoopDelay, performance } = require("perf_hooks");

const serviceName = process.env.OTEL_SERVICE_NAME || "express-victim-service";
// OTLP targets the collector only — never VictoriaMetrics, Tempo, or Loki directly.
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";
const traceEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || `${otlpEndpoint}/v1/traces`;
const metricEndpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || `${otlpEndpoint}/v1/metrics`;
const logEndpoint = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || `${otlpEndpoint}/v1/logs`;

const resource = new Resource({
  [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
  [SemanticResourceAttributes.SERVICE_VERSION]: "1.0.0",
  [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || "development",
  [SemanticResourceAttributes.HOST_NAME]: os.hostname(),
});

const metricReader = new PeriodicExportingMetricReader({
  exporter: new OTLPMetricExporter({
    url: metricEndpoint,
    // Exemplars ride OTLP metric payloads when histograms are recorded under an active span.
  }),
  exportIntervalMillis: 1000,
});

const sdk = new NodeSDK({
  resource,
  metricReader,
  traceExporter: new OTLPTraceExporter({ url: traceEndpoint }),
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-http": { enabled: true },
      "@opentelemetry/instrumentation-express": { enabled: true },
    }),
  ],
});

const otelLoggerProvider = new LoggerProvider({ resource });
otelLoggerProvider.addLogRecordProcessor(
  new BatchLogRecordProcessor(new OTLPLogExporter({ url: logEndpoint }))
);
logs.setGlobalLoggerProvider(otelLoggerProvider);
const otelAppLogger = logs.getLogger("express-victim-service-logger");

function enrichLogWithSpanContext(info) {
  const span = trace.getSpan(context.active());
  const spanContext = span ? span.spanContext() : null;
  info.trace_id = spanContext ? spanContext.traceId : null;
  info.span_id = spanContext ? spanContext.spanId : null;
  info["service.name"] = serviceName;
  if (!info.component) {
    info.component = "express-victim-service";
  }
  return info;
}

class OTelWinstonTransport extends Transport {
  log(info, callback) {
    const attributes = {
      timestamp: info.timestamp,
      level: info.level,
      message: info.message,
      "service.name": info["service.name"] || serviceName,
      component: info.component || "express-victim-service",
    };

    if (info.trace_id) {
      attributes.trace_id = info.trace_id;
    }
    if (info.span_id) {
      attributes.span_id = info.span_id;
    }

    if (info.meta && typeof info.meta === "object") {
      Object.entries(info.meta).forEach(([key, value]) => {
        attributes[key] = typeof value === "string" ? value : JSON.stringify(value);
      });
    }

    otelAppLogger.emit({
      severityText: String(info.level || "info").toUpperCase(),
      body: info.message,
      attributes,
      traceId: info.trace_id || undefined,
      spanId: info.span_id || undefined,
    });

    callback();
  }
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format(enrichLogWithSpanContext),
    winston.format.printf((info) => {
      // Agent/Loki schema: structured JSON with trace_id + span_id for 3D correlation.
      return JSON.stringify({
        timestamp: info.timestamp,
        level: info.level,
        message: info.message,
        trace_id: info.trace_id || null,
        span_id: info.span_id || null,
        "service.name": info["service.name"],
        component: info.component,
        ...(info.meta && typeof info.meta === "object" ? { meta: info.meta } : {}),
      });
    })
  ),
  transports: [new winston.transports.Console(), new OTelWinstonTransport()],
});

const meter = metrics.getMeter("express-victim-service-meter");
const eluHistogram = monitorEventLoopDelay({ resolution: 20 });
eluHistogram.enable();
let previousElu = performance.eventLoopUtilization();
let latestEluRatio = 0;
let latestP99DelayMs = 0;
let latestOldSpaceBytes = 0;
let latestNewSpaceBytes = 0;
let latestOldSpaceMaxBytes = 0;
let latestOpenFds = 0;
let latestMaxFds = resolveMaxFds();
let dbPoolActive = 0;
const dbPoolMax = 10;

setInterval(() => {
  const currentElu = performance.eventLoopUtilization(previousElu);
  previousElu = currentElu;

  // SLI PromQL expects a 0–1 fraction (e.g. > 0.90), not a percentage.
  latestEluRatio = Math.min(1, Math.max(0, currentElu.utilization));
  latestP99DelayMs = eluHistogram.percentile(99) / 1e6;
  eluHistogram.reset();

  const spaces = v8.getHeapSpaceStatistics();
  const oldSpace = spaces.find((space) => space.space_name === "old_space");
  const newSpace = spaces.find((space) => space.space_name === "new_space");
  latestOldSpaceBytes = oldSpace ? oldSpace.space_used_size : 0;
  latestNewSpaceBytes = newSpace ? newSpace.space_used_size : 0;
  latestOldSpaceMaxBytes = oldSpace ? oldSpace.space_size : v8.getHeapStatistics().heap_size_limit;
  latestOpenFds = getOpenFdEstimate();
  latestMaxFds = resolveMaxFds();
}, 1000).unref();

const eluGauge = meter.createObservableGauge("node_event_loop_utilization", {
  description: "Fraction of time the event loop is busy (0–1). Spikes on block-loop fault.",
  unit: "1",
});
eluGauge.addCallback((observableResult) => {
  observableResult.observe(latestEluRatio);
});

const p99DelayGauge = meter.createObservableGauge("node_event_loop_delay_p99_ms", {
  description: "p99 event loop delay in milliseconds",
  unit: "ms",
});
p99DelayGauge.addCallback((observableResult) => {
  observableResult.observe(latestP99DelayMs);
});

const heapGauge = meter.createObservableGauge("nodejs_v8_heap_space_size_bytes", {
  description: "Heap space usage by V8 space — old_space trend reveals memory-leak endpoint.",
  unit: "By",
});
heapGauge.addCallback((observableResult) => {
  observableResult.observe(latestOldSpaceBytes, { space: "old_space" });
  observableResult.observe(latestNewSpaceBytes, { space: "new_space" });
});

const heapMaxGauge = meter.createObservableGauge("v8_heap_space_size_max_bytes", {
  description: "Configured max size per V8 heap space for utilization SLI denominators",
  unit: "By",
});
heapMaxGauge.addCallback((observableResult) => {
  observableResult.observe(latestOldSpaceMaxBytes, { space: "old_space" });
});

const openFdGauge = meter.createObservableGauge("process_open_fds", {
  description: "Open file descriptors — rises when fd-leak endpoint retains handles",
  unit: "{fd}",
});
openFdGauge.addCallback((observableResult) => {
  observableResult.observe(latestOpenFds);
});

const maxFdGauge = meter.createObservableGauge("process_max_fds", {
  description: "OS file descriptor soft limit for FD utilization alerts",
  unit: "{fd}",
});
maxFdGauge.addCallback((observableResult) => {
  observableResult.observe(latestMaxFds);
});

const dbPoolGauge = meter.createObservableGauge("db_client_connections_usage", {
  description: "Simulated PostgreSQL pool usage for db-crash SLI alerts",
  unit: "{connection}",
});
dbPoolGauge.addCallback((observableResult) => {
  observableResult.observe(dbPoolActive, { state: "active" });
  observableResult.observe(Math.max(0, dbPoolMax - dbPoolActive), { state: "idle" });
  observableResult.observe(dbPoolMax, { state: "max" });
});

function recordDbPoolPressure() {
  dbPoolActive = Math.min(dbPoolMax, dbPoolActive + 2);
  setTimeout(() => {
    dbPoolActive = Math.max(0, dbPoolActive - 1);
  }, 30_000);
}

function getOpenFdEstimate() {
  if (process.platform === "linux") {
    try {
      return fs.readdirSync("/proc/self/fd").length;
    } catch (error) {
      logger.warn("Unable to read /proc/self/fd for process_open_fds", {
        component: "filesystem",
        meta: { error: error.message },
      });
    }
  }

  return process._getActiveHandles ? process._getActiveHandles().length : 0;
}

function resolveMaxFds() {
  if (process.platform === "linux") {
    try {
      const limits = fs.readFileSync("/proc/self/limits", "utf8");
      const match = limits.match(/Max open files\s+(\d+)\s+(\d+)/);
      if (match) {
        return Number.parseInt(match[2], 10);
      }
    } catch (_error) {
      // fall through
    }
  }
  return 1024;
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  const secretKeys = new Set(["password", "passwd", "token", "secret", "authorization"]);
  const out = Array.isArray(payload) ? [] : {};

  Object.entries(payload).forEach(([key, value]) => {
    if (secretKeys.has(key.toLowerCase())) {
      out[key] = "[REDACTED]";
      return;
    }

    if (value && typeof value === "object") {
      out[key] = sanitizePayload(value);
      return;
    }

    out[key] = value;
  });

  return out;
}

async function startTelemetry() {
  await sdk.start();
  logger.info("OpenTelemetry initialized — exporting via OTLP collector", {
    component: "telemetry",
    meta: { otlpEndpoint, serviceName },
  });
}

async function shutdownTelemetry() {
  await sdk.shutdown();
  await otelLoggerProvider.shutdown();
}

module.exports = {
  SpanStatusCode,
  context,
  logger,
  recordDbPoolPressure,
  sanitizePayload,
  shutdownTelemetry,
  startTelemetry,
  trace,
};
