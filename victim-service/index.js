const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  logger,
  startTelemetry,
  shutdownTelemetry,
  trace,
  SpanStatusCode,
  sanitizePayload,
  context,
  recordDbPoolPressure,
} = require("./telemetry");

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

  logger.warn("Fault injection: blocking event loop synchronously", {
    component: "event-loop",
    meta: { blockForMs, endpoint: "/api/fault/block-loop" },
  });

  const start = Date.now();
  while (Date.now() - start < blockForMs) {
    // Busy-spin drives node_event_loop_utilization toward 1.0 for vmalert SLI firing.
    Math.sqrt(Math.random() * 1000);
  }

  res.status(200).json({
    endpoint: "/api/fault/block-loop",
    blockedMs: blockForMs,
    message: "Event loop was intentionally blocked",
  });
});

app.post("/api/fault/db-crash", async (req, res) => {
  recordDbPoolPressure();

  await tracer.startActiveSpan("db.query_execution", async (span) => {
    const sql = "SELECT * FROM users WHERE email = $1 FOR UPDATE NOWAIT";
    span.setAttribute("db.statement", sql);
    span.setAttribute("db.system", "postgresql");

    try {
      await simulateDbFailure(req.body);
      res.status(200).json({ message: "Unexpected success" });
    } catch (error) {
      span.recordException(error);
      span.setAttribute("http.request.body.sanitized", JSON.stringify(sanitizePayload(req.body)));
      span.setAttribute("process.memory.rss.bytes", process.memoryUsage().rss);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });

      logger.error("Database query connection timeout pool exhausted", {
        component: "database-pool",
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
    }
  });
});

app.get("/api/fault/memory-leak", (_req, res) => {
  const chunk = Array.from({ length: 20_000 }, () => ({
    payload: "x".repeat(1024),
    timestamp: Date.now(),
  }));
  memoryLeakStore.push(chunk);

  logger.warn("Fault injection: retaining heap chunk in global store", {
    component: "memory",
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

    logger.warn("Fault injection: file descriptor opened and not closed", {
      component: "filesystem",
      meta: { leakedFdCount: leakedFds.length },
    });

    res.status(200).json({
      endpoint: "/api/fault/fd-leak",
      leakedFdCount: leakedFds.length,
      message: "Opened file descriptor and intentionally did not close it",
    });
  } catch (error) {
    logger.error("FD leak injection failed", {
      component: "filesystem",
      meta: { error: error.message },
    });
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
      component: "http-server",
      meta: { port, pid: process.pid, host: os.hostname() },
    });
  });
}

bootstrap().catch((error) => {
  logger.error("Failed to start service", {
    component: "bootstrap",
    meta: { error: error.stack || error.message },
  });
  process.exit(1);
});

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, async () => {
    logger.info(`Received ${signal}, shutting down`, { component: "lifecycle" });
    await shutdownTelemetry();
    process.exit(0);
  });
});
