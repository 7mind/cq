/**
 * @cq/server workflow module — `/plan` WorkflowRuntime (phase 1).
 */

export { parsePlanCommand } from "./commandRegistry.js";
export type {
  ParsedCommand,
  PlanNewCommand,
  PlanContinueCommand,
  MalformedCommand,
} from "./commandRegistry.js";
export {
  WorkflowRuntime,
  SPEC_MILESTONE_TITLE,
} from "./workflowRuntime.js";
export type {
  WorkflowRuntimeOpts,
  WorkflowEventSink,
  ProducerSelector,
  StartPlanInput,
  StartPlanResult,
  WorkflowPosition,
} from "./workflowRuntime.js";
export {
  ProducerOutputSchema,
  ProducerQuestionSchema,
  buildProducerPrompt,
} from "./producer.js";
export type {
  WorkflowProducer,
  ProducerOutput,
  ProducerQuestion,
  ProduceRequest,
} from "./producer.js";
export { ClaudeProducer } from "./claudeProducer.js";
export type { ClaudeProducerOpts, QueryFactory as ProducerQueryFactory } from "./claudeProducer.js";
export { CodexProducer } from "./codexProducer.js";
export type { CodexProducerOpts } from "./codexProducer.js";
export {
  CLARIFY_REVIEW_SPEC,
  PLAN_SPEC,
  PLAN_REVIEW_SPEC,
  ClarifyReviewOutputSchema,
  PlanOutputSchema,
  PlanReviewOutputSchema,
  buildClarifyReviewPrompt,
  buildPlannerPrompt,
  buildPlanReviewPrompt,
} from "./phases.js";
export type {
  PhaseSubagent,
  PhaseSpec,
  PhaseRequest,
  PhaseKind,
  PhaseSubagentSelector,
  ClarifyReviewOutput,
  PlanOutput,
  PlanReviewOutput,
  PlanMilestone,
  PlanTask,
  PlanFinding,
  ReviewQuestion,
  QnA,
  PlanArtifacts,
} from "./phases.js";
export { ClaudePhaseSubagent } from "./claudePhaseSubagent.js";
export type {
  ClaudePhaseSubagentOpts,
  QueryFactory as PhaseQueryFactory,
} from "./claudePhaseSubagent.js";
export { CodexPhaseSubagent } from "./codexPhaseSubagent.js";
export type { CodexPhaseSubagentOpts } from "./codexPhaseSubagent.js";
