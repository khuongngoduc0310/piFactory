import type {
  ExecutionBudget,
  ExecutionTier,
  FactoryRun,
  FactoryRunStatus,
} from "../domain/factory-run.js";
import type { FailureInfo } from "../domain/work-node.js";
import type { WorkGraph } from "../domain/work-graph.js";

export const PERSISTENCE_SCHEMA_VERSION = 1 as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export const RUN_EVENT_TYPES = [
  "factory_run_created",
  "factory_run_started",
  "node_created",
  "node_ready",
  "node_started",
  "node_completed",
  "node_failed",
  "node_retried",
  "role_requested",
  "role_authorized",
  "role_rejected",
  "human_decision_requested",
  "human_decision_recorded",
  "tier_escalated",
  "worktree_created",
  "worktree_removed",
  "baseline_recorded",
  "factory_run_completed",
  "factory_run_failed",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export interface NewRunEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly type: RunEventType;
  readonly payload: JsonObject;
}

export interface RunEvent extends NewRunEvent {
  readonly schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION;
  readonly runId: string;
  readonly sequence: number;
}

export interface EventLogHeader {
  readonly schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION;
  readonly kind: "event_log";
  readonly runId: string;
  readonly stateVersion: number;
}

export interface PersistedRunMetadata {
  readonly id: string;
  readonly request: string;
  readonly tier: ExecutionTier;
  readonly status: FactoryRunStatus;
  readonly budget: ExecutionBudget;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failure?: FailureInfo;
}

export interface RunDocument {
  readonly schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION;
  readonly runId: string;
  readonly stateVersion: number;
  readonly state: PersistedRunMetadata;
}

export interface GraphDocument {
  readonly schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION;
  readonly runId: string;
  readonly stateVersion: number;
  readonly graph: WorkGraph;
}

export interface CurrentStateDocument {
  readonly schemaVersion: typeof PERSISTENCE_SCHEMA_VERSION;
  readonly runId: string;
  readonly stateVersion: number;
  readonly stateDirectory: string;
}

export interface LoadedRun {
  readonly run: FactoryRun;
  readonly events: readonly RunEvent[];
  readonly stateVersion: number;
}

export interface PersistenceLimits {
  readonly maxRunIdBytes: number;
  readonly maxCurrentFileBytes: number;
  readonly maxRunFileBytes: number;
  readonly maxGraphFileBytes: number;
  readonly maxEventLogBytes: number;
  readonly maxEventLineBytes: number;
  readonly maxEventPayloadBytes: number;
  readonly maxJsonDepth: number;
  readonly maxJsonEntries: number;
  readonly maxJsonArrayLength: number;
  readonly maxJsonStringLength: number;
}

export const DEFAULT_PERSISTENCE_LIMITS: PersistenceLimits = Object.freeze({
  maxRunIdBytes: 1_024,
  maxCurrentFileBytes: 16 * 1_024,
  maxRunFileBytes: 1 * 1_024 * 1_024,
  maxGraphFileBytes: 10 * 1_024 * 1_024,
  maxEventLogBytes: 10 * 1_024 * 1_024,
  maxEventLineBytes: 256 * 1_024,
  maxEventPayloadBytes: 128 * 1_024,
  maxJsonDepth: 20,
  maxJsonEntries: 1_000,
  maxJsonArrayLength: 1_000,
  maxJsonStringLength: 128 * 1_024,
});
