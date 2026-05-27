import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import {
  resumeAfterHumanReview,
  runIncidentFromWebhook,
  sendNotiForHumanApproval,
  type VmalertWebhookPayload,
} from "./index.js";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

function threadIdFromPayload(payload: VmalertWebhookPayload): string {
  const alert = payload.alerts?.[0];
  return (
    alert?.fingerprint ??
    alert?.labels?.alertname ??
    `incident-${Date.now()}`
  );
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok", service: "sre-agent" });
});

app.post("/webhook/vmalert", async (req: Request, res: Response) => {
  const payload = req.body as VmalertWebhookPayload;
  const threadId = threadIdFromPayload(payload);

  console.log(`[sre-agent] vmalert webhook received (thread=${threadId})`);

  const state = await runIncidentFromWebhook(payload, threadId);
  await sendNotiForHumanApproval(threadId, state);
  res.status(202).json({
    status: "paused_for_human_review",
    threadId,
    message:
      "RCA workflow paused after remediation. POST /api/incidents/:threadId/resume with humanApproval.",
    state,
  });
});

app.post("/api/incidents/:threadId/resume", async (req: Request, res: Response) => {
  const { threadId } = req.params;
  const { humanApproval } = req.body as { humanApproval?: string };

  if (
    humanApproval !== "approved" &&
    humanApproval !== "rejected" &&
    humanApproval !== "escalated"
  ) {
    res.status(400).json({
      error: 'humanApproval must be "approved", "rejected", or "escalated"',
    });
    return;
  }

  console.log(`[sre-agent] resuming thread=${threadId} humanApproval=${humanApproval}`);

  const state = await resumeAfterHumanReview(threadId, humanApproval);
  res.status(200).json({ status: "completed", threadId, state });
});

app.post("/api/slack/actions", async (req: Request, res: Response) => {
  if (!req.body.payload) {
    return res.status(400).send("Missing payload");
  }

  const payload = JSON.parse(req.body.payload);

  const humanApproval = payload.actions[0].value as "approved" | "rejected" | "escalated";
  const threadId = payload.message.metadata.event_payload.threadId as string;

  await resumeAfterHumanReview(threadId, humanApproval);

  return res.status(200).json({
    text: `✅ Action recorded: *${humanApproval.toUpperCase()}* by <@${payload.user.id}>`,
    replace_original: true 
  });
})

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "not_found" });
});

app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  console.error("[sre-agent] request error", err);
  res.status(500).json({
    error: "internal_error",
    message: err instanceof Error ? err.message : String(err),
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[sre-agent] listening on http://${HOST}:${PORT}`);
  console.log("[sre-agent] POST /webhook/vmalert — Alertmanager trigger");
  console.log("[sre-agent] POST /api/incidents/:threadId/resume — human-in-the-loop");
});

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const shutdown = () => server.close();
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export { app, server };
