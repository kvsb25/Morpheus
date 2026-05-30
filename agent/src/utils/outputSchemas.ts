import {z} from "zod";

export const RCA_REVIEWER_OUTPUT_SCHEMA = z.object({
    status: z.enum(["APPROVED", "REJECTED"]).describe("Whether the interpretation is approved or rejected."),
    targetNode: z.enum(["interpretationAgent", "deterministicAnalyst", "remediationAgent"]).describe("The node that should be targeted for the next step."),
    requiredCorrection: z.object({
        forDeterministicAnalyst: z.string().optional().describe("Specific feedback for the Deterministic Analyst, if they are the target."),
        forInterpretationAgent: z.string().optional().describe("Specific feedback for the Interpretation Agent, if they are the target."),
    }).optional().describe("Detailed corrections required to be made by the targeted node(s)."),
    logicalLeap: z.string().optional().describe("Explanation of the logical leap or flaw in the interpretation that led to rejection, if applicable."),
})