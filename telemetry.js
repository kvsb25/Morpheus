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
  exporter: new OTLPMetricExporter({ url: metricEndpoint }),
  exportIntervalMillis: 1000,
});

const sdk = new NodeSDK({
  resource,
  metricReader,
  traceExporter: new OTLPTraceExporter({ url: traceEndpoint }),
  instrumentations: [getNodeAutoInstrumentations()],
});

const otelLoggerProvider = new LoggerProvider({ resource });
otelLoggerProvider.addLogRecordProcessor(
  new BatchLogRecordProcessor(new OTLPLogExporter({ url: logEndpoint }))
);
logs.setGlobalLoggerProvider(otelLoggerProvider);
const otelAppLogger = logs.getLogger("express-victim-service-logger");

class OTelWinstonTransport extends Transport {
  log(info, callback) {
    const span = trace.getSpan(context.active());
    const spanContext = span ? span.spanContext() : null;

    const attributes = {
      "log.level": info.level,
      "log.message": info.message,
    };

    if (spanContext) {
      attributes.trace_id = spanContext.traceId;
      attributes.span_id = spanContext.spanId;
    }

    if (info.meta && typeof info.meta === "object") {
      Object.entries(info.meta).forEach(([key, value]) => {
        attributes[`log.meta.${key}`] = typeof value === "string" ? value : JSON.stringify(value);
      });
    }

    otelAppLogger.emit({
      severityText: String(info.level || "info").toUpperCase(),
      body: info.message,
      attributes,
    });

    callback();
  }
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf((info) => {
      const span = trace.getSpan(context.active());
      const spanContext = span ? span.spanContext() : null;
      const traceId = spanContext ? spanContext.traceId : "no-trace";
      const spanId = spanContext ? spanContext.spanId : "no-span";
      const base = `[${info.timestamp}] [${info.level}] [trace_id=${traceId}] [span_id=${spanId}] ${info.message}`;
      return info.meta ? `${base} ${JSON.stringify(info.meta)}` : base;
    })
  ),
  transports: [new winston.transports.Console(), new OTelWinstonTransport()],
});

const meter = metrics.getMeter("express-victim-service-meter");
const eluHistogram = monitorEventLoopDelay({ resolution: 20 });
eluHistogram.enable();
let previousElu = performance.eventLoopUtilization();
let latestEluPercent = 0;
let latestP99DelayMs = 0;
let latestOldSpaceBytes = 0;
let latestNewSpaceBytes = 0;
let latestOpenFds = 0;

setInterval(() => {
  const currentElu = performance.eventLoopUtilization(previousElu);
  previousElu = currentElu;

  latestEluPercent = Math.min(100, Math.max(0, currentElu.utilization * 100));
  latestP99DelayMs = eluHistogram.percentile(99) / 1e6;
  eluHistogram.reset();

  const spaces = v8.getHeapSpaceStatistics();
  const oldSpace = spaces.find((space) => space.space_name === "old_space");
  const newSpace = spaces.find((space) => space.space_name === "new_space");
  latestOldSpaceBytes = oldSpace ? oldSpace.space_used_size : 0;
  latestNewSpaceBytes = newSpace ? newSpace.space_used_size : 0;

  latestOpenFds = getOpenFdEstimate();
}, 1000).unref();

const eluGauge = meter.createObservableGauge("node_event_loop_utilization", {
  description: "Event loop utilization percentage sampled every second",
  unit: "%",
});
eluGauge.addCallback((observableResult) => {
  observableResult.observe(latestEluPercent);
});

const p99DelayGauge = meter.createObservableGauge("node_event_loop_delay_p99_ms", {
  description: "p99 event loop delay in milliseconds",
  unit: "ms",
});
p99DelayGauge.addCallback((observableResult) => {
  observableResult.observe(latestP99DelayMs);
});

const heapGauge = meter.createObservableGauge("nodejs_v8_heap_space_size_bytes", {
  description: "Heap space usage by V8 space",
  unit: "By",
});
heapGauge.addCallback((observableResult) => {
  observableResult.observe(latestOldSpaceBytes, { space: "old_space" });
  observableResult.observe(latestNewSpaceBytes, { space: "new_space" });
});

const openFdGauge = meter.createObservableGauge("process_open_fds", {
  description: "Estimated open file descriptor count",
  unit: "{fd}",
});
openFdGauge.addCallback((observableResult) => {
  observableResult.observe(latestOpenFds);
});

function getOpenFdEstimate() {
  // Linux exposes exact descriptor count via /proc; fallback keeps metric available cross-platform.
  if (process.platform === "linux") {
    try {
      return fs.readdirSync("/proc/self/fd").length;
    } catch (error) {
      logger.warn("Unable to read /proc/self/fd for process_open_fds", { meta: { error: error.message } });
    }
  }

  return process._getActiveHandles ? process._getActiveHandles().length : 0;
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
  logger.info("OpenTelemetry initialized", {
    meta: { traceEndpoint, metricEndpoint, logEndpoint, serviceName },
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
  sanitizePayload,
  shutdownTelemetry,
  startTelemetry,
  trace,
};
