import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import {
  resumeAfterHumanReview,
  runDemoIncident,
  runIncidentFromWebhook,
  sendNotiForHumanApproval,
  type VmalertWebhookPayload,
} from "./index.js";

// When true the webhook posts a scripted Slack approval card instead of running
// the RCA graph. Presentation aid only — see runDemoIncident in index.ts.
const DEMO_MODE = process.env.DEMO_MODE === "true";

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
// Slack posts interactive payloads as application/x-www-form-urlencoded with a
// single `payload` field. Without this parser req.body.payload is undefined and
// every button click fails.
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok", service: "sre-agent" });
});

app.post("/webhook/vmalert", async (req: Request, res: Response) => {
  const payload = req.body as VmalertWebhookPayload;
  // safely access alert props by payload.alerts[0]
  const threadId = threadIdFromPayload(payload);

  console.log(`[sre-agent] vmalert webhook received (thread=${threadId})`);

  const state = DEMO_MODE
    ? await runDemoIncident(payload, threadId)
    : await runIncidentFromWebhook(payload, threadId);
  await sendNotiForHumanApproval(threadId, state);
  res.status(202).json({
    status: "paused_for_human_review",
    threadId,
    message:
      "RCA workflow paused after remediation. POST /api/incidents/:threadId/resume with humanApproval.",
    state,
  });
});

/**
 * Slack interactive-component endpoint (set this URL in the app's Interactivity
 * settings; an ngrok tunnel works for dev).
 *
 * Slack closes the interaction if it does not get a 2xx within 3 seconds, so this
 * replies immediately and resumes the graph in the background rather than awaiting it.
 */
app.post("/api/slack/actions", async (req: Request, res: Response) => {
  if (!req.body?.payload) {
    return res.status(400).send("Missing payload");
  }

  const payload = JSON.parse(req.body.payload);
  const action = payload.actions?.[0];
  const humanApproval = action?.value as "approved" | "rejected" | "escalated";

  // message.metadata is not guaranteed to survive the round trip, so fall back to
  // the threadId encoded in the block_id when building the card.
  const threadId: string | undefined =
    payload.message?.metadata?.event_payload?.threadId ??
    (typeof action?.block_id === "string" && action.block_id.includes(":")
      ? action.block_id.slice(action.block_id.indexOf(":") + 1)
      : undefined);

  if (!humanApproval || !threadId) {
    console.error("[sre-agent] slack action missing approval or threadId", {
      humanApproval,
      block_id: action?.block_id,
    });
    return res.status(200).json({
      text: "⚠️ Could not resolve which incident this button belongs to.",
      replace_original: false,
    });
  }

  console.log(`[sre-agent] slack action ${humanApproval} (thread=${threadId})`);

  // Answer Slack first — the resume path runs the graph and takes far longer than
  // Slack's 3s budget.
  res.status(200).json({
    text: `✅ Action recorded: *${humanApproval.toUpperCase()}* by <@${payload.user?.id ?? "unknown"}>`,
    replace_original: true,
  });

  if (DEMO_MODE) {
    // No graph ran, so there is no checkpoint to resume from.
    console.log(`[sre-agent] DEMO_MODE — skipping graph resume for ${humanApproval}`);
    return;
  }

  try {
    await resumeAfterHumanReview(threadId, humanApproval);
    console.log(`[sre-agent] workflow resumed and completed (thread=${threadId})`);
  } catch (err) {
    console.error(`[sre-agent] resume failed (thread=${threadId})`, err);
  }
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
