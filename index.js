const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { logger, startTelemetry, shutdownTelemetry, trace, SpanStatusCode, sanitizePayload, context } = require("./telemetry");

const app = express();
app.use(express.json({ limit: "2mb" }));

const tracer = trace.getTracer("express-victim-service-tracer");
const memoryLeakStore = [];
const leakedFds = [];
const leakFilePath = path.join(__dirname, "fd-leak-dummy.txt");

if (!fs.existsSync(leakFilePath)) {
  fs.writeFileSync(leakFilePath, "fd leak target\n", "utf8");
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "express-victim-service" });
});

app.get("/api/fault/block-loop", (req, res) => {
  const duration = Number.parseInt(req.query.duration, 10);
  const blockForMs = Number.isFinite(duration) && duration > 0 ? duration : 3000;

  logger.warn("Fault injection: block event loop", { meta: { blockForMs } });
  const start = Date.now();
  while (Date.now() - start < blockForMs) {
    // Intentionally busy-spin so ELU reaches near 100% and reveals synchronous starvation.
    Math.sqrt(Math.random() * 1000);
  }

  res.status(200).json({
    endpoint: "/api/fault/block-loop",
    blockedMs: blockForMs,
    message: "Event loop was intentionally blocked",
  });
});

app.post("/api/fault/db-crash", async (req, res) => {
  await context.with(context.active(), async () => {
    await tracer.startActiveSpan("db.query_execution", async (span) => {
      // SRE agents need the exact failing statement and DB engine to classify deterministic query faults.
      const sql = "SELECT * FROM users WHERE email = $1 FOR UPDATE NOWAIT";
      span.setAttribute("db.statement", sql);
      span.setAttribute("db.system", "postgresql");

      try {
        await simulateDbFailure(req.body);
        res.status(200).json({ message: "Unexpected success" });
      } catch (error) {
        // Deterministic stack traces are critical for Phase-1 "how it failed" RCA.
        span.recordException(error);

        // Sanitized payload helps correlate bad inputs without leaking secrets in telemetry backends.
        span.setAttribute("http.request.body.sanitized", JSON.stringify(sanitizePayload(req.body)));

        // Memory snapshot at failure helps detect pressure-related query instability.
        span.setAttribute("process.memory.rss.bytes", process.memoryUsage().rss);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

        logger.error("Fault injection: simulated DB crash", {
          meta: {
            error: error.message,
            sanitizedBody: sanitizePayload(req.body),
            rssBytes: process.memoryUsage().rss,
          },
        });

        res.status(500).json({
          endpoint: "/api/fault/db-crash",
          message: "Simulated database timeout/crash",
          error: error.message,
        });
      } finally {
        span.end();
      }
    });
  });
});

app.get("/api/fault/memory-leak", (_req, res) => {
  // Retained references make old_space grow over time so OTel heap-space metrics surface a leak trend.
  const chunk = new Array(20_000).fill({
    payload: "x".repeat(1024),
    timestamp: Date.now(),
  });
  memoryLeakStore.push(chunk);

  logger.warn("Fault injection: memory leak growth", {
    meta: { retainedChunks: memoryLeakStore.length, rssBytes: process.memoryUsage().rss },
  });

  res.status(200).json({
    endpoint: "/api/fault/memory-leak",
    retainedChunks: memoryLeakStore.length,
    rssBytes: process.memoryUsage().rss,
    message: "Leak chunk retained in global memory store",
  });
});

app.get("/api/fault/fd-leak", (_req, res) => {
  try {
    const fd = fs.openSync(leakFilePath, "r");
    leakedFds.push(fd);

    // Keeping descriptors open drives process_open_fds upward for deterministic FD exhaustion alerts.
    logger.warn("Fault injection: file descriptor leak", { meta: { leakedFdCount: leakedFds.length } });

    res.status(200).json({
      endpoint: "/api/fault/fd-leak",
      leakedFdCount: leakedFds.length,
      message: "Opened file descriptor and intentionally did not close it",
    });
  } catch (error) {
    logger.error("FD leak injection failed", { meta: { error: error.message } });
    res.status(500).json({
      endpoint: "/api/fault/fd-leak",
      message: "Failed to leak file descriptor",
      error: error.message,
    });
  }
});

function simulateDbFailure(body) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      const hint = body && body.queryHint ? String(body.queryHint) : "pool exhausted";
      reject(new Error(`Simulated PostgreSQL failure: ${hint}`));
    }, 250);
  });
}

async function bootstrap() {
  await startTelemetry();

  const port = Number.parseInt(process.env.PORT, 10) || 3000;
  app.listen(port, () => {
    logger.info("express-victim-service listening", {
      meta: {
        port,
        pid: process.pid,
        host: os.hostname(),
      },
    });
  });
}

bootstrap().catch((error) => {
  logger.error("Failed to start service", { meta: { error: error.stack || error.message } });
  process.exit(1);
});

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, async () => {
    logger.info(`Received ${signal}, shutting down`);
    await shutdownTelemetry();
    process.exit(0);
  });
});
