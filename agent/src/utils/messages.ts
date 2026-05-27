import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";

export function getLastAiMessageContent(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg instanceof AIMessage) {
      return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    }
  }
  return "";
}

export function hasPendingToolCalls(messages: BaseMessage[]): boolean {
  const last = messages[messages.length - 1];
  return last instanceof AIMessage && Boolean(last.tool_calls?.length);
}

export function extractTraceIdFromMessages(messages: BaseMessage[]): string | null {
  for (const msg of messages) {
    if (msg instanceof ToolMessage && msg.name === "fetch_alert_context") {
      try {
        const payload = JSON.parse(String(msg.content));
        if (typeof payload.trace_id === "string") {
          return payload.trace_id;
        }
      } catch {
        // ignore parse errors
      }
    }
  }
  return null;
}

export function extractIncidentFromMessages(messages: BaseMessage[]): {
  alertId: string;
  metricName: string;
  timestamp: string;
} | null {
  for (const msg of messages) {
    if (msg instanceof ToolMessage && msg.name === "fetch_alert_context") {
      try {
        const payload = JSON.parse(String(msg.content));
        return {
          alertId: payload.alert_id ?? "unknown",
          metricName: payload.metric_name ?? "unknown",
          timestamp: payload.timestamp ?? new Date().toISOString(),
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function extractProposedAction(content: string): {
  scriptName: string;
  params: Record<string, unknown>;
  reasoning: string;
} | null {
  const jsonMatch = content.match(/\{[\s\S]*"scriptName"[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      scriptName?: string;
      params?: Record<string, unknown>;
      reasoning?: string;
    };
    if (parsed.scriptName && parsed.reasoning) {
      return {
        scriptName: parsed.scriptName,
        params: parsed.params ?? {},
        reasoning: parsed.reasoning,
      };
    }
  } catch {
    return null;
  }
  return null;
}
