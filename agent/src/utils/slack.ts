import { WebClient } from "@slack/web-api";
import { GraphStateType } from "../state.js";

// Initialize Slack client with your Bot Token
const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

export async function sendSlackIncidentAlert(channelId: string, threadId: string, alertDetails: Omit<GraphStateType, "messages">) {
  await slackClient.chat.postMessage({
    channel: channelId,
    text: `⚠️ Critical Alert: ${alertDetails?.incident?.alertId}`, // Fallback text for smartwatches/notifications
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*🚨 Incident Triggered: ${alertDetails?.incident?.alertId}*\n*Metric:* ${alertDetails?.incident?.metricName}\n*Timestamp:* ${alertDetails?.incident?.timestamp}\n\n*Proposed Action: *\`\`\`${alertDetails?.proposedAction}\`\`\``,
        },
      },
      {
        type: "actions",
        block_id: "incident_actions_block",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve Remediation ✅" },
            style: "primary",
            value: "approved", 
            action_id: "btn_approve",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Reject ❌" },
            style: "danger",
            value: "rejected",
            action_id: "btn_reject",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Escalate ⚠️" },
            value: "escalated",
            action_id: "btn_escalate",
          },
        ],
      },
    ],
    metadata: {
      event_type: "incident_review",
      event_payload: { threadId },
    },
  });
}