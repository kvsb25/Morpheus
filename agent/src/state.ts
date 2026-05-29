import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

export type Incident = {
  alertId: string;
  alertName: string;
  metricName: string;
  timestamp: string;
};

export type ProposedAction = {
  scriptName: string;
  params: Record<string, unknown>;
  reasoning: string;
};

export type HumanApproval = "pending" | "approved" | "rejected" | "escalated";

export type OTLPEvent = {
  timeUnixNano: string;
  name: string;
  attributes: {
    key: string;
    value: {
      stringValue?: string;
      intValue?: number;
      boolValue?: boolean;
    };
  }[];
}

/** Last-write-wins reducer for scalar state fields updated by agent nodes. */
function lastValue<T>(_: T, update: T): T {
  return update;
}

export const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  incident: Annotation<Incident | null>({
    reducer: lastValue,
    default: () => null,
  }),
  traceId: Annotation<string | null>({
    reducer: lastValue,
    default: () => null,
  }),
  traceEvents: Annotation<OTLPEvent[] | null>({
    reducer: lastValue,
    default: () => null,
  }),
  deterministicAnalysis: Annotation<string | null>({
    reducer: lastValue,
    default: () => null,
  }),
  interpretation: Annotation<string | null>({
    reducer: lastValue,
    default: () => null,
  }),
  reviewFeedback: Annotation<string | null>({
    reducer: lastValue,
    default: () => null,
  }),
  revisionCount: Annotation<number>({
    reducer: lastValue,
    default: () => 0,
  }),
  proposedAction: Annotation<ProposedAction | null>({
    reducer: lastValue,
    default: () => null,
  }),
  humanApproval: Annotation<HumanApproval>({
    reducer: lastValue,
    default: () => "pending",
  }),
});

export type GraphStateType = typeof GraphState.State;
