import { DomainError } from "./domain-error.js";
import {
  markWorkNodeBlocked,
  markWorkNodeCompleted,
  markWorkNodeFailed,
  markWorkNodeReady,
  markWorkNodeRunning,
  markWorkNodeWaitingHuman,
  retryWorkNode,
  snapshotWorkNode,
  unblockWorkNode,
  validateWorkNode,
  type WorkNode,
  type WorkNodeCompletion,
} from "./work-node.js";

export interface WorkGraph {
  readonly nodes: readonly WorkNode[];
}

export type GraphValidationIssueCode =
  | "duplicate_node_id"
  | "duplicate_dependency"
  | "self_dependency"
  | "missing_dependency"
  | "dependency_not_completed"
  | "dependency_completed_too_late"
  | "invalid_node"
  | "cycle";

export interface GraphValidationIssue {
  readonly code: GraphValidationIssueCode;
  readonly message: string;
  readonly nodeId?: string;
  readonly dependencyId?: string;
  readonly cycle?: readonly string[];
}

export interface GetDependentsOptions {
  readonly transitive?: boolean;
}

function issue(
  code: GraphValidationIssueCode,
  message: string,
  fields: Omit<GraphValidationIssue, "code" | "message"> = {},
): GraphValidationIssue {
  return Object.freeze({ code, message, ...fields });
}

function nodeMap(nodes: readonly WorkNode[]): ReadonlyMap<string, WorkNode> {
  const result = new Map<string, WorkNode>();
  for (const node of nodes) {
    if (!result.has(node.id)) {
      result.set(node.id, node);
    }
  }
  return result;
}

export function detectCycles(nodes: readonly WorkNode[]): readonly (readonly string[])[] {
  const byId = nodeMap(nodes);
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const cycleKeys = new Set<string>();

  const visit = (nodeId: string): void => {
    state.set(nodeId, "visiting");
    stack.push(nodeId);
    const node = byId.get(nodeId);

    for (const dependencyId of [...(node?.dependsOn ?? [])].sort()) {
      if (!byId.has(dependencyId)) {
        continue;
      }
      const dependencyState = state.get(dependencyId);
      if (dependencyState === undefined) {
        visit(dependencyId);
        continue;
      }
      if (dependencyState === "visiting") {
        const start = stack.indexOf(dependencyId);
        const cycle = [...stack.slice(start), dependencyId];
        const key = cycle.join("\u0000");
        if (!cycleKeys.has(key)) {
          cycleKeys.add(key);
          cycles.push(cycle);
        }
      }
    }

    stack.pop();
    state.set(nodeId, "visited");
  };

  for (const nodeId of [...byId.keys()].sort()) {
    if (state.get(nodeId) === undefined) {
      visit(nodeId);
    }
  }

  return Object.freeze(
    cycles
      .sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000")))
      .map((cycle) => Object.freeze(cycle)),
  );
}

export function validateDependencies(
  nodes: readonly WorkNode[],
): readonly GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const validNodes: WorkNode[] = [];
  const nodeIdCounts = new Map<string, number>();

  for (const node of nodes) {
    const nodeIssues = validateWorkNode(node);
    for (const nodeIssue of nodeIssues) {
      issues.push(
        issue("invalid_node", nodeIssue.message),
      );
    }
    if (nodeIssues.length === 0) {
      validNodes.push(node);
    }
  }

  const byId = nodeMap(validNodes);

  for (const node of validNodes) {
    nodeIdCounts.set(node.id, (nodeIdCounts.get(node.id) ?? 0) + 1);
  }
  for (const [nodeId, count] of [...nodeIdCounts].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (count > 1) {
      issues.push(
        issue("duplicate_node_id", `WorkGraph contains duplicate node id ${nodeId}`, {
          nodeId,
        }),
      );
    }
  }

  for (const node of [...validNodes].sort((left, right) => left.id.localeCompare(right.id))) {
    const dependencyCounts = new Map<string, number>();
    for (const dependencyId of node.dependsOn) {
      dependencyCounts.set(
        dependencyId,
        (dependencyCounts.get(dependencyId) ?? 0) + 1,
      );
    }
    for (const [dependencyId, count] of [...dependencyCounts].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (count > 1) {
        issues.push(
          issue(
            "duplicate_dependency",
            `WorkNode ${node.id} contains duplicate dependency ${dependencyId}`,
            { nodeId: node.id, dependencyId },
          ),
        );
      }
    }
  }

  for (const node of [...validNodes].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const dependencyId of [...new Set(node.dependsOn)].sort()) {
      if (dependencyId === node.id) {
        issues.push(
          issue("self_dependency", `WorkNode ${node.id} cannot depend on itself`, {
            nodeId: node.id,
            dependencyId,
          }),
        );
      } else if (!byId.has(dependencyId)) {
        issues.push(
          issue(
            "missing_dependency",
            `WorkNode ${node.id} references missing dependency ${dependencyId}`,
            { nodeId: node.id, dependencyId },
          ),
        );
      }
    }
  }

  const dependencySensitiveStatuses = new Set([
    "ready",
    "running",
    "waiting_human",
    "completed",
    "failed",
  ]);
  for (const node of [...validNodes].sort((left, right) => left.id.localeCompare(right.id))) {
    const hasReadyHistory = node.executionHistory.some(
      ({ status }) => status === "ready",
    );
    for (const dependencyId of node.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (
        dependency !== undefined &&
        (dependencySensitiveStatuses.has(node.status) || hasReadyHistory) &&
        dependency.status !== "completed"
      ) {
        issues.push(
          issue(
            "dependency_not_completed",
            `WorkNode ${node.id} is ${node.status} while dependency ${dependencyId} is ${dependency.status}`,
            { nodeId: node.id, dependencyId },
          ),
        );
      } else if (dependency?.status === "completed") {
        const completedAt = dependency.executionHistory
          .filter(({ status }) => status === "completed")
          .at(-1)?.at;
        const readyBeforeDependency = node.executionHistory.some(
          ({ status, at }) =>
            status === "ready" &&
            completedAt !== undefined &&
            Date.parse(at) < Date.parse(completedAt),
        );
        if (completedAt === undefined || readyBeforeDependency) {
          issues.push(
            issue(
              "dependency_completed_too_late",
              `WorkNode ${node.id} became ready before dependency ${dependencyId} completed`,
              { nodeId: node.id, dependencyId },
            ),
          );
        }
      }
    }
  }

  for (const cycle of detectCycles(validNodes)) {
    issues.push(
      issue("cycle", `WorkGraph contains cycle ${cycle.join(" -> ")}`, { cycle }),
    );
  }

  return Object.freeze(issues);
}

export function createWorkGraph(nodes: readonly WorkNode[] = []): WorkGraph {
  const issues = validateDependencies(nodes);
  if (issues.length > 0) {
    throw new DomainError(
      "invalid_graph",
      issues.map(({ message }) => message).join("; "),
    );
  }

  return Object.freeze({
    nodes: Object.freeze(
      nodes
        .map(snapshotWorkNode)
        .sort((left, right) => left.id.localeCompare(right.id)),
    ),
  });
}

export function getNode(graph: WorkGraph, nodeId: string): WorkNode {
  const node = graph.nodes.find(({ id }) => id === nodeId);
  if (node === undefined) {
    throw new DomainError("node_not_found", `WorkGraph does not contain node ${nodeId}`);
  }
  return node;
}

function replaceNode(graph: WorkGraph, replacement: WorkNode): WorkGraph {
  return createWorkGraph(
    graph.nodes.map((node) => (node.id === replacement.id ? replacement : node)),
  );
}

function dependenciesCompleted(graph: WorkGraph, node: WorkNode): boolean {
  return node.dependsOn.every(
    (dependencyId) => getNode(graph, dependencyId).status === "completed",
  );
}

function assertDependenciesCompleted(graph: WorkGraph, node: WorkNode): void {
  if (!dependenciesCompleted(graph, node)) {
    throw new DomainError(
      "dependency_not_completed",
      `WorkNode ${node.id} has incomplete dependencies`,
    );
  }
}

export function addNode(graph: WorkGraph, node: WorkNode): WorkGraph {
  if (node.status !== "pending") {
    throw new DomainError("invalid_graph", "Only pending WorkNodes can be added");
  }
  if (graph.nodes.some(({ id }) => id === node.id)) {
    throw new DomainError("invalid_graph", `WorkGraph already contains node ${node.id}`);
  }
  return createWorkGraph([...graph.nodes, node]);
}

export function addDependency(
  graph: WorkGraph,
  nodeId: string,
  dependencyId: string,
): WorkGraph {
  const node = getNode(graph, nodeId);
  getNode(graph, dependencyId);
  if (node.status !== "pending") {
    throw new DomainError(
      "invalid_graph",
      `Dependencies can be added only to pending WorkNodes`,
    );
  }
  if (node.dependsOn.includes(dependencyId)) {
    throw new DomainError(
      "invalid_graph",
      `WorkNode ${nodeId} already depends on ${dependencyId}`,
    );
  }
  return replaceNode(graph, {
    ...node,
    dependsOn: Object.freeze([...node.dependsOn, dependencyId].sort()),
  });
}

export function getReadyNodes(graph: WorkGraph): readonly WorkNode[] {
  return Object.freeze(
    graph.nodes.filter(
      (node) =>
        (node.status === "pending" || node.status === "ready") &&
        dependenciesCompleted(graph, node),
    ),
  );
}

export function getBlockedNodes(graph: WorkGraph): readonly WorkNode[] {
  return Object.freeze(
    graph.nodes.filter((node) => {
      if (node.status === "blocked") {
        return true;
      }
      if (node.status !== "pending" && node.status !== "ready") {
        return false;
      }
      return node.dependsOn.some((dependencyId) => {
        const status = getNode(graph, dependencyId).status;
        return status === "failed" || status === "blocked";
      });
    }),
  );
}

export function getDependents(
  graph: WorkGraph,
  nodeId: string,
  options: GetDependentsOptions = {},
): readonly WorkNode[] {
  getNode(graph, nodeId);
  const result = new Map<string, WorkNode>();
  let frontier = [nodeId];

  do {
    const next: string[] = [];
    for (const dependencyId of frontier) {
      for (const node of graph.nodes) {
        if (node.dependsOn.includes(dependencyId) && !result.has(node.id)) {
          result.set(node.id, node);
          next.push(node.id);
        }
      }
    }
    frontier = next;
  } while (options.transitive === true && frontier.length > 0);

  return Object.freeze(
    [...result.values()].sort((left, right) => left.id.localeCompare(right.id)),
  );
}

export function markNodeReady(
  graph: WorkGraph,
  nodeId: string,
  at: string,
  reason?: string,
): WorkGraph {
  const node = getNode(graph, nodeId);
  assertDependenciesCompleted(graph, node);
  return replaceNode(graph, markWorkNodeReady(node, at, reason));
}

export function markNodeRunning(
  graph: WorkGraph,
  nodeId: string,
  at: string,
): WorkGraph {
  const node = getNode(graph, nodeId);
  assertDependenciesCompleted(graph, node);
  return replaceNode(graph, markWorkNodeRunning(node, at));
}

export function markNodeWaitingHuman(
  graph: WorkGraph,
  nodeId: string,
  at: string,
  reason: string,
): WorkGraph {
  return replaceNode(graph, markWorkNodeWaitingHuman(getNode(graph, nodeId), at, reason));
}

export function markNodeCompleted(
  graph: WorkGraph,
  nodeId: string,
  at: string,
  completion: WorkNodeCompletion = {},
): WorkGraph {
  return replaceNode(
    graph,
    markWorkNodeCompleted(getNode(graph, nodeId), at, completion),
  );
}

export function markNodeFailed(
  graph: WorkGraph,
  nodeId: string,
  at: string,
  reason: string,
): WorkGraph {
  return replaceNode(graph, markWorkNodeFailed(getNode(graph, nodeId), at, reason));
}

export function markNodeBlocked(
  graph: WorkGraph,
  nodeId: string,
  at: string,
  reason: string,
): WorkGraph {
  return replaceNode(graph, markWorkNodeBlocked(getNode(graph, nodeId), at, reason));
}

export function retryNode(
  graph: WorkGraph,
  nodeId: string,
  at: string,
  reason: string,
): WorkGraph {
  const node = getNode(graph, nodeId);
  assertDependenciesCompleted(graph, node);
  return replaceNode(graph, retryWorkNode(node, at, reason));
}

export function unblockNode(
  graph: WorkGraph,
  nodeId: string,
  at: string,
  reason: string,
): WorkGraph {
  const node = getNode(graph, nodeId);
  const hasUnclearedDependency = node.dependsOn.some((dependencyId) => {
    const status = getNode(graph, dependencyId).status;
    return status === "failed" || status === "blocked";
  });
  if (hasUnclearedDependency) {
    throw new DomainError(
      "dependency_not_completed",
      `WorkNode ${node.id} still has a failed or blocked dependency`,
    );
  }
  return replaceNode(graph, unblockWorkNode(node, at, reason));
}
