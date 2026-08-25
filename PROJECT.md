You are helping me design and implement a greenfield project called piFactory.

# Project Overview

piFactory is a durable, deterministic, multi-agent software-engineering execution engine.

Its purpose is to coordinate AI coding workers so software tasks can be planned,

implemented, debugged, tested, integrated, reviewed, and documented safely and

efficiently.

piFactory should behave like an autonomous software-engineering factory.

A user submits a software task.

piFactory determines:

- how complex the task is

- whether planning is necessary

- what work needs to be done

- what work can run in parallel

- which AI workers should be invoked

- what each worker is allowed to modify

- how outputs should be validated

- whether another worker is required

- whether human judgment is required

- whether completed work can be reused

- whether the workflow can safely finish

The system combines ideas from:

- workflow engines

- distributed job schedulers

- durable execution systems

- AI coding agents

- build systems

- task DAGs

- capability-based security

- optimistic concurrency control

- fault-tolerant systems

# High-Level Goal

Small tasks should remain extremely cheap.

Example:

User Request

    ↓

Builder

    ↓

Targeted Validation

    ↓

Done

Large tasks may become:

User Request

    ↓

Planner

    ↓

Work DAG

    ↓

┌───────────┬───────────┬───────────┐

Builder A   Builder B   Builder C

└───────────┴─────┬─────┴───────────┘

                  ↓

          Builder(integrate)

                  ↓

           Builder(test)

                  ↓

              Reviewer

                  ↓

                 Done

# Core Architecture Principle

The piFactory runtime itself must be deterministic application code.

Do NOT make the main orchestrator an LLM.

LLMs may:

- analyze

- explore

- plan

- implement

- diagnose

- test

- integrate

- review

- recommend next actions

But deterministic code must control:

- workflow state

- scheduling

- concurrency

- permissions

- mutation boundaries

- budgets

- retries

- worktree lifecycle

- checkpoints

- human escalation

- result acceptance

Core rule:

Agents recommend.

piFactory authorizes.

# Core Abstractions

The most important abstractions are:

FactoryRun

Workflow

WorkGraph

WorkNode

Artifact

TaskPacket

RoleResult

Scheduler

ExecutionPolicy

Workspace

Checkpoint

# Critical Invariants

These rules must always hold.

## 1. WorkNode != Agent Session

A WorkNode represents durable logical work.

An AI session represents one temporary attempt to perform that work.

Example:

WorkNode B7

├── Builder session 1

├── Builder(debug) session

└── Builder session 2

All three sessions may participate in the same WorkNode.

The WorkNode survives even if every AI session disappears.

## 2. Agent Sessions Are Disposable

Workflow correctness must never depend on preserving a specific model conversation.

A fresh worker must be able to continue using:

- WorkNode objective

- repository state

- artifacts

- previous results

- diagnosis

- acceptance criteria

- human decisions

## 3. WorkNodes Are Durable

Persist:

- objective

- dependencies

- status

- scope

- acceptance criteria

- input digest

- output digest

- artifact references

- retries

- failure information

- execution history

## 4. Agents Never Directly Spawn Agents

An agent may request another capability.

Example:

{

  "status": "request_role",

  "role": "builder",

  "builderMode": "debug",

  "reason": "Failure requires deeper diagnosis"

}

The scheduler decides whether that request is allowed.

## 5. LLM Output Is Untrusted

Deterministically validate:

- paths

- mutation scopes

- DAGs

- dependencies

- role requests

- Builder modes

- requested concurrency

- artifacts

- reported changed files

Never trust an agent simply because it says an action is safe.

## 6. Human Attention Is Expensive

Do not ask humans to approve routine execution.

Human input should normally be limited to:

- ambiguous requirements

- meaningful architecture tradeoffs

- major scope expansion

- destructive actions

- security/privacy decisions

- external side effects

- budget extensions

- accepting unresolved failures

## 7. Human Decisions Auto-Continue

Normal flow:

NeedHuman

    ↓

persist request

    ↓

user responds

    ↓

persist decision

    ↓

scheduler continues automatically

Do not require /resume after routine human interaction.

## 8. /resume Is Recovery

/resume should primarily exist for:

- process crashes

- application shutdown

- terminal loss

- interrupted execution

- explicit user pause

It should not be normal workflow control.

## 9. Use the Minimum Number of LLM Calls

Simple request target:

Planner: 0

Builder: 1

Reviewer: 0

Human: 0

## 10. Parallel Mutation Requires Isolation

Concurrent workers modifying code should normally work in independent Git worktrees.

## 11. Existing Repository Failures Are Not Automatically New Failures

Validation should detect regressions relative to the starting state.

## 12. Every Mutation Must Be Independently Verified

Do not rely on an agent's changed-files report.

Inspect the actual workspace.

# Initial Agent Roles

Start with only three primary roles.

# Planner

Planner is responsible for understanding large or ambiguous work.

Capabilities:

- read repository

- search repository

- inspect architecture

- identify dependencies

- decompose work

- create WorkNodes

- define acceptance criteria

- estimate risk

- identify potential parallelism

- identify expected mutation scopes

Planner is read-only.

Planner must not:

- mutate the repository

- execute its own plan

- directly start Builders

Small tasks should skip Planner.

# Builder

Builder is the general execution worker.

Builder supports modes:

type BuilderMode =

  | "implement"

  | "debug"

  | "test"

  | "integrate"

  | "document";

## Builder(implement)

Implement a WorkNode.

## Builder(debug)

Investigate failures.

Prefer creating a structured diagnosis artifact.

Do not mutate unnecessarily.

## Builder(test)

Create tests, improve tests, or perform task-specific validation.

## Builder(integrate)

Combine completed WorkNode outputs.

Resolve straightforward integration problems.

## Builder(document)

Update documentation when behavior affecting users or developers changes.

# Reviewer

Reviewer independently tries to find problems.

Reviewer should normally be read-only.

Reviewer looks for:

- incorrect behavior

- missed requirements

- unsafe changes

- regressions

- incomplete handling

- architectural inconsistencies

- security problems

Reviewer should be conditional.

Do not invoke Reviewer automatically for every FAST task.

# Execution Tiers

Support:

FAST

STANDARD

DEEP

# FAST

Used for:

- small localized change

- clear request

- low risk

- small scope

Typical flow:

Request

  ↓

Builder(implement)

  ↓

Targeted checks

  ↓

Done

Normally:

- no Planner

- no worktree

- no Reviewer

- no broad baseline

- no human decision

Target:

1 LLM call where possible.

# STANDARD

Used for:

- moderate multi-file changes

- subsystem-level changes

- moderate uncertainty

- moderate risk

Possible flow:

Planner if needed

    ↓

Builder

    ↓

Validation

    ↓

Reviewer if warranted

    ↓

Done

# DEEP

Used for:

- large tasks

- architecture changes

- many files

- multiple subsystems

- migrations

- parallelizable work

- high-risk changes

Typical flow:

Planner

    ↓

Validated Work DAG

    ↓

Parallel Builders

    ↓

Integration

    ↓

Broader validation

    ↓

Reviewer

    ↓

Documentation if necessary

# Tier Classification

Prefer deterministic classification first.

Signals may include:

- explicitly mentioned file count

- expected changed-file count

- subsystem count

- public API changes

- CLI changes

- dependency changes

- configuration changes

- database migrations

- infrastructure changes

- destructive operations

- external effects

- architectural impact

- ambiguity

- security risk

- likely parallelism

Execution may escalate:

FAST → STANDARD → DEEP

when new complexity is discovered.

# FactoryRun

A FactoryRun represents one complete user request being processed by piFactory.

Example:

interface FactoryRun {

  id: string;

  request: string;

  tier:

    | "fast"

    | "standard"

    | "deep";

  status:

    | "created"

    | "running"

    | "waiting_human"

    | "completed"

    | "failed"

    | "cancelled";

  graph: WorkGraph;

  budget: ExecutionBudget;

  createdAt: string;

  updatedAt: string;

}

# WorkNode

WorkNode is the most important durable execution unit.

Example:

interface WorkNode {

  id: string;

  objective: string;

  role:

    | "planner"

    | "builder"

    | "reviewer";

  builderMode?: BuilderMode;

  status:

    | "pending"

    | "ready"

    | "running"

    | "blocked"

    | "waiting_human"

    | "completed"

    | "failed";

  dependsOn: string[];

  scope: {

    relevantPaths?: string[];

    allowedMutationPaths?: string[];

    forbiddenPaths?: string[];

    subsystems?: string[];

  };

  acceptanceCriteria: string[];

  risk:

    | "low"

    | "medium"

    | "high";

  complexity:

    | "small"

    | "medium"

    | "large";

  parallelSafe: boolean;

  inputDigest?: string;

  outputDigest?: string;

  artifactRefs: string[];

  retryCount: number;

}

# WorkGraph

Complex workflows are represented as a directed acyclic graph.

Example:

       A

      / \\

     B   C

      \\ /

       D

WorkGraph should support:

addNode()

addDependency()

getReadyNodes()

getBlockedNodes()

getDependents()

markRunning()

markCompleted()

markFailed()

validateDependencies()

detectCycles()

WorkGraph should be implemented using deterministic, testable code.

No LLM should be involved in basic graph operations.

# Planner DAG

Planner should produce structured WorkNode proposals.

Example:

{

  "nodes": [

    {

      "id": "auth-interface",

      "objective": "Define authentication provider interface",

      "role": "builder",

      "builderMode": "implement",

      "dependsOn": [],

      "scope": {

        "allowedMutationPaths": [

          "src/auth/types.ts"

        ]

      },

      "acceptanceCriteria": [

        "Interface supports authentication and token refresh"

      ],

      "risk": "medium",

      "complexity": "small",

      "parallelSafe": false

    },

    {

      "id": "google-auth",

      "objective": "Implement Google authentication provider",

      "role": "builder",

      "builderMode": "implement",

      "dependsOn": [

        "auth-interface"

      ],

      "scope": {

        "allowedMutationPaths": [

          "src/auth/google.ts"

        ]

      },

      "parallelSafe": true

    }

  ]

}

# Planner Validation

Before accepting Planner output, validate:

- unique IDs

- node count

- valid roles

- valid Builder modes

- existing dependencies

- DAG acyclicity

- legal paths

- legal mutation scopes

- fan-out limits

- concurrency limits

- impossible dependencies

- obviously conflicting parallel scopes

Planner proposes the graph.

piFactory decides whether the graph is valid.

# Scheduler

The deterministic scheduler is the control center of piFactory.

Responsibilities:

- identify ready WorkNodes

- enforce dependencies

- enforce concurrency limits

- detect mutation conflicts

- enforce budgets

- authorize requested roles

- enforce retries

- escalate execution tier

- schedule worktrees

- persist state

- handle human decisions

- determine workflow completion

Conceptually:

while (!factoryRunFinished) {

    readyNodes = graph.getReadyNodes()

    runnableNodes =

        executionPolicy.selectRunnable(

            readyNodes,

            activeNodes,

            executionBudget,

            conflictState

        )

    execute(runnableNodes)

    persist()

}

Start with:

maxParallelAgents = 1

until sequential execution is reliable.

# RoleResult

All agent roles should use one structured result protocol.

Example:

type RoleResult =

  | {

      status: "done";

      artifactRefs: string[];

    }

  | {

      status: "need_context";

      requests: ContextRequest[];

    }

  | {

      status: "request_role";

      role:

        | "planner"

        | "builder"

        | "reviewer";

      builderMode?: BuilderMode;

      reason: string;

      evidenceRefs?: string[];

    }

  | {

      status: "need_human";

      decision: HumanDecisionRequest;

    }

  | {

      status: "escalate";

      reason: string;

    }

  | {

      status: "failed";

      reason: string;

    };

Agents return recommendations.

The scheduler owns control flow.

# TaskPacket

Agents should receive compact task-specific context.

Do not send the complete workflow conversation to every worker.

Example:

interface TaskPacket {

  workNodeId: string;

  objective: string;

  userRequest: string;

  executionTier:

    | "fast"

    | "standard"

    | "deep";

  scope: {

    relevantPaths?: string[];

    allowedMutationPaths?: string[];

    forbiddenPaths?: string[];

  };

  acceptanceCriteria: string[];

  constraints: string[];

  contextRefs: string[];

  permissions: {

    read: boolean;

    search: boolean;

    execute: boolean;

    mutate: boolean;

  };

  budget: {

    maxTokens?: number;

    maxToolCalls?: number;

  };

}

# Context Store

Agents should communicate through durable artifacts, not direct session-to-session conversation.

Artifact types may include:

- plan

- exploration

- implementation

- diagnosis

- test

- integration

- review

- baseline

- human decision

Example:

interface Artifact {

  id: string;

  type: string;

  workNodeId?: string;

  summary: string;

  facts: string[];

  assumptions: string[];

  unresolvedQuestions: string[];

  evidenceRefs: string[];

  changedFiles?: string[];

  digest: string;

}

Persist useful conclusions and evidence.

Do not persist hidden chain-of-thought.

# Persistence

Use:

.pifactory/

  runs/

    <run-id>/

      run.json

      graph.json

      events.jsonl

      checkpoint-latest.json

      nodes/

      artifacts/

      decisions/

      worktrees/

State must survive process crashes.

Use atomic persistence.

# Event Log

Maintain an append-only event stream.

Possible events:

factory_run_created

factory_run_started

node_created

node_ready

node_started

node_completed

node_failed

node_retried

role_requested

role_authorized

role_rejected

human_decision_requested

human_decision_recorded

tier_escalated

worktree_created

worktree_removed

baseline_recorded

factory_run_completed

factory_run_failed

Each event should contain:

- unique ID

- monotonically increasing sequence

- timestamp

- event type

- structured payload

# Digests

Use cryptographic digests such as SHA-256.

Canonicalize structured data before hashing.

Useful digest types:

workspaceDigest

configDigest

inputDigest

outputDigest

artifactDigest

checkpointDigest

Expected digest means:

"This is the state that this operation assumes still exists."

Example:

Worker begins

    ↓

relevant state digest = X

    ↓

worker performs task

    ↓

recompute relevant state

    ↓

X == current

    → assumptions still valid

X != current

    → assumptions changed

    → investigate before accepting result

# Scoped Digests

Do not hash the entire repository unnecessarily.

A WorkNode should ideally hash only relevant dependencies.

Example:

WorkNode depends on:

src/auth.ts

src/session.ts

artifact-plan-A

Compute:

inputDigest =

  SHA256(

    canonical(

      objective

      + relevant file digests

      + dependency artifact digests

      + human decisions

    )

  )

# Optimistic Concurrency

piFactory should generally use optimistic concurrency.

Do not lock the whole repository during every operation.

Instead:

1. record expected state

2. allow work

3. validate state before accepting the result

If relevant state changed:

do not blindly accept stale output.

Possible actions:

- revalidate

- retry

- integrate

- rebase

- replan

- escalate

# Idempotency

Retries must be safe wherever possible.

Store:

- WorkNode status

- input digest

- output digest

- output artifact

On restart:

node completed?

    ↓

input digest unchanged?

    ↓

artifact still valid?

    ↓

reuse result

Do not invoke another LLM unnecessarily.

# Workspace Snapshot

Track workspace state using:

- repository-relative file path

- content hash

- file mode

- symlink target

Compare snapshots to determine:

added

modified

deleted

# Mutation Boundaries

Each mutating WorkNode receives explicit mutation permissions.

Example:

allowedMutationPaths:

src/auth/google.ts

tests/auth/google.test.ts

If the actual mutation also contains:

package.json

piFactory must detect the violation.

Do not trust the worker's own changed-files report.

# Least Privilege

Hard-code maximum capabilities per role.

Planner:

- read

- search

Reviewer:

- read

- search

Builder:

- read

- search

- execute approved commands

- mutate assigned scope

Configuration may reduce capabilities.

Configuration may not silently expand hard-coded role authority.

# Path Security

Treat all agent-provided paths as untrusted.

Reject:

- absolute paths

- Windows drive paths

- ..

- .

- empty segments

- URLs

- control characters

- path traversal attempts

Normalize before comparison.

# Filesystem Security

Use defensive file access where appropriate.

Include:

- bounded reads

- symlink validation

- atomic writes

- path normalization

- file identity checks

- TOCTOU protection when necessary

# Run Lease

Only one piFactory runtime should own a FactoryRun.

Lease data may include:

- random ownership token

- process ID

- hostname

- timestamp

If a process crashes, stale lease recovery should be possible.

The lease prevents:

two independent piFactory processes

→ simultaneously controlling the same FactoryRun

# Parallel Execution

Add parallel execution only after sequential execution is reliable.

A node may run when:

- dependencies are completed

- node is parallel-safe

- mutation scope does not conflict

- worker capacity exists

- execution budget allows it

Example:

      Interface

          ↓

    ┌─────┴─────┐

    ↓           ↓

 Google       GitHub

Google and GitHub may execute concurrently.

# Git Worktree Isolation

Use worktrees mainly for parallel mutation.

Example:

project/

.pifactory/worktrees/

worker-google/

worker-github/

worker-database/

Do not create a worktree for every trivial FAST task.

Worktrees prevent direct filesystem interference.

They do NOT guarantee semantic compatibility.

# Conflict Detection

Check conflicts:

before execution

AND

after execution.

Before execution:

compare predicted scopes.

After execution:

inspect actual changed files.

Example:

Predicted:

A → src/google/*

B → src/github/*

But both actually modify:

src/auth/index.ts

The scheduler must detect the shared mutation.

# Integration

Use:

Builder(mode="integrate")

for fan-in operations.

Example:

Builder A ─┐

Builder B ─┼→ Builder(integrate)

Builder C ─┘

The integration worker should receive:

- dependency artifacts

- diffs

- changed files

- relevant interfaces

- validation results

- acceptance criteria

# Differential Baseline Validation

A repository does not need to start completely green.

Example:

Before:

lint   PASS

unit   FAIL

build  PASS

After:

lint   PASS

unit   FAIL

build  PASS

No new regression.

But:

Before:

unit PASS

After:

unit FAIL

New regression detected.

# Human Decision Model

Use structured human decisions.

Example:

interface HumanDecisionRequest {

  kind:

    | "requirement"

    | "scope_expansion"

    | "architecture_tradeoff"

    | "destructive_action"

    | "security"

    | "external_side_effect"

    | "budget_extension"

    | "override";

  question: string;

  reason: string;

  options: {

    id: string;

    label: string;

    consequences: string;

  }[];

  recommendedOption?: string;

  evidenceRefs: string[];

}

# Execution Budgets

Prevent runaway execution.

Example:

interface ExecutionBudget {

  maxParallelAgents: number;

  maxAgentCalls: number;

  maxRetriesPerNode: number;

  maxTokens?: number;

  maxCostUsd?: number;

}

# Loop Detection

Track invocation history:

interface InvocationRecord {

  role: string;

  builderMode?: string;

  workNodeId: string;

  reason: string;

  inputDigest: string;

  resultDigest?: string;

}

Detect no-progress loops:

Builder(implement)

→ Builder(debug)

→ Builder(implement)

→ Builder(debug)

If inputs, evidence, and failure state have not meaningfully changed:

stop the loop and escalate.

# Crash Recovery

On restart:

load FactoryRun

    ↓

acquire lease

    ↓

validate persisted state

    ↓

validate checkpoint

    ↓

inspect WorkNodes

    ↓

reuse valid completed work

    ↓

recover incomplete nodes

    ↓

restart scheduler

# Testing Architecture

Separate tests into:

unit

integration

system/worktree

## Unit Tests

Should be fast and parallelizable.

Test:

- WorkGraph

- cycle detection

- dependency handling

- scheduler policy

- execution tiers

- budgets

- digest generation

- path validation

- mutation-scope validation

- loop detection

- RoleResult authorization

## Integration Tests

Test:

- persistence

- checkpoints

- crash recovery

- context artifacts

- human continuation

- idempotency

- Builder execution

## Worktree/System Tests

Test:

- real Git repositories

- worktree creation

- worktree cleanup

- parallel isolation

- integration conflicts

Keep these relatively few because they are expensive.

# Observability

Expose workflow state clearly.

Example:

piFactory Run: 92AF

Tier: DEEP

Planner                   completed

Auth Interface            completed

Google Builder            completed

GitHub Builder            running

Database Builder          completed

Integration               blocked

Reviewer                  pending

Workers: 1 / 4

Agent Calls: 5 / 15

Retries: 1

Human Decisions: 0

Tokens: 48k

Also expose important decisions:

FAST → STANDARD

Reason:

Expected one-file change expanded into six-file subsystem change.

# Recommended Directory Structure

src/

  domain/

    factory-run.ts

    workflow.ts

    work-node.ts

    work-graph.ts

    artifact.ts

  scheduler/

    scheduler.ts

    execution-policy.ts

    execution-tier.ts

    conflict-policy.ts

    budgets.ts

    loop-detection.ts

  agents/

    agent-runner.ts

    planner.ts

    builder.ts

    reviewer.ts

    role-result.ts

  context/

    context-store.ts

    task-packet.ts

  workspace/

    workspace-snapshot.ts

    digest.ts

    mutation-scope.ts

    path-validation.ts

    workspace-attestation.ts

    worktree.ts

  persistence/

    run-store.ts

    event-store.ts

    checkpoint-store.ts

    atomic-write.ts

    run-lease.ts

  validation/

    targeted-checks.ts

    baseline.ts

    differential-baseline.ts

  decisions/

    human-decision.ts

  runtime/

    factory-runtime.ts

  ui/

# Implementation Order

## Phase 1 — Domain Core

Implement:

FactoryRun

WorkNode

WorkGraph

Artifact types

Implement DAG validation.

No agents.

## Phase 2 — Persistence

Implement:

run storage

event log

atomic writes

reload

Prove completed nodes survive application restart.

## Phase 3 — Safety Foundation

Implement:

canonical SHA-256 hashing

workspace snapshots

workspace deltas

path validation

mutation boundaries

## Phase 4 — Sequential Scheduler

Implement:

dependency scheduling

state transitions

retry policy

budget tracking

Use one worker at a time.

## Phase 5 — Builder

Add the first LLM integration.

Flow:

Request

↓

FactoryRun

↓

Builder WorkNode

↓

Scheduler

↓

Builder

↓

Mutation Validation

↓

Targeted Validation

↓

Artifact

↓

Complete

## Phase 6 — FAST Vertical Slice

Make trivial coding tasks excellent.

Target:

Planner = 0

Builder = 1

Reviewer = 0

Human = 0

Worktree = 0

## Phase 7 — Durable Context

Add:

Artifact Store

TaskPacket

structured cross-session context

## Phase 8 — Builder Modes

Add:

debug

test

integrate

document

## Phase 9 — Idempotent Execution

Reuse completed nodes after interruptions when inputs remain valid.

## Phase 10 — Planner

Add Planner decomposition and WorkGraph generation.

## Phase 11 — Planner Validation

Treat generated DAG as untrusted input.

## Phase 12 — Parallel Scheduler

Run independent nodes concurrently.

## Phase 13 — Worktree Isolation

Isolate concurrent mutation workers.

## Phase 14 — Integration

Add Builder(integrate).

## Phase 15 — Differential Baseline

Detect new regressions relative to initial state.

## Phase 16 — Reviewer

Add conditional independent review.

## Phase 17 — Human Decisions

Implement durable auto-continuing decisions.

## Phase 18 — Budgets and Loop Detection

Prevent runaway multi-agent execution.

## Phase 19 — Crash Recovery

Implement checkpoints, leases, and safe recovery.

## Phase 20 — Observability

Build CLI/dashboard visibility.

# First Milestone

Do NOT start by implementing the full system.

The first usable piFactory should be:

User Request

     ↓

FactoryRun

     ↓

Builder WorkNode

     ↓

Deterministic Scheduler

     ↓

Builder

     ↓

Workspace Validation

     ↓

Targeted Checks

     ↓

Persist Artifact

     ↓

Complete WorkNode

     ↓

Complete FactoryRun

This vertical slice should be reliable before Planner, Reviewer,

parallelism, and worktrees are introduced.

# Non-Goals for Initial piFactory

Do not initially build:

- many specialized agents

- LLM Coordinator

- unrestricted shell access

- distributed remote workers

- Kubernetes scheduling

- mandatory worktrees

- mandatory Planner

- mandatory Reviewer

- automatic deployment

- arbitrary autonomous external actions

# Future Evolution

Only specialize roles when actual performance data justifies it.

Possible future roles:

Builder(debug)

→ Debugger

Builder(test)

→ Tester

Builder(integrate)

→ Integrator

Builder(document)

→ Documenter

Planner exploration

→ Explorer

A future AI Coordinator may provide scheduling recommendations,

but deterministic piFactory code must retain execution authority.

# Engineering Principles

Prefer:

- TypeScript

- strong types

- pure deterministic functions

- explicit state machines

- immutable artifacts

- dependency injection

- structured validation

- fail-closed security

- canonical serialization

- small modules

- fast unit tests

- durable execution

Avoid:

- giant orchestration functions

- agents controlling workflow state directly

- session-to-session correctness dependencies

- unrestricted agent permissions

- free-form parsing where structured output is possible

- unnecessary LLM calls

- mandatory heavyweight worktrees

- repeatedly stopping the user for approvals

# Before Coding

Before writing implementation code, produce:

1. proposed directory tree

2. FactoryRun interface

3. WorkNode interface

4. WorkGraph API

5. WorkNode state machine

6. FactoryRun state machine

7. scheduler responsibilities

8. RoleResult protocol

9. artifact model

10. persistence model

11. digest strategy

12. mutation-security model

13. first vertical-slice architecture

14. initial unit/integration/system testing strategy

Then implement only Phase 1.

Do not attempt to implement the entire final system at once.
