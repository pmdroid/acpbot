/**
 * EVE — Extraterrestrial Vegetation Evaluator.
 * Background multi-agent directives (WALL-E-inspired). Not ultracode.
 */
import { z } from "zod";

export const EVE_BRAND = "EVE";
export const EVE_FULL_NAME = "Extraterrestrial Vegetation Evaluator";
export const EVE_TAGLINE =
  "Background multi-agent directives. Like AUTO on the Axiom — you only get the plant.";

export type EveRunStatus =
  | "pending_approval"
  | "running"
  | "paused"
  | "waiting_user"
  | "completed"
  | "failed"
  | "killed";

export type EveNodeStatus =
  | "pending"
  | "running"
  | "waiting_user"
  | "done"
  | "failed"
  | "skipped";

export type EvePhaseStatus = {
  title: string;
  status: "pending" | "active" | "done" | "failed";
  agentCount: number;
};

export type EveNodeState = {
  status: EveNodeStatus;
  childSessionKey?: string;
  result?: unknown;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  label?: string;
  phase?: string;
};

/** One choice in host.ask / the auto-ask when a run returns blocked. */
export type EveAskOption = {
  id: string;
  label: string;
  description?: string;
};

export type EveAskAnswer = {
  id: string;
  label: string;
  index: number;
};

/** Parked operator question. Run status is waiting_user until answered. */
export type EvePendingAsk = {
  key: string;
  question: string;
  options: EveAskOption[];
  createdAt: number;
  reason?: "script" | "blocked_return";
  answered?: EveAskAnswer;
};

export type EveBudgetState = {
  agentsMax: number;
  agentsUsed: number;
  deadlineAt?: number;
};

export type EveRun = {
  runId: string;
  name: string;
  sessionKey: string;
  repoKey: string;
  repoRoot: string;
  status: EveRunStatus;
  scriptPath: string;
  args?: unknown;
  phases: EvePhaseStatus[];
  nodes: Record<string, EveNodeState>;
  /** Completed agent() results keyed by cache key for resume. */
  resultCache: Record<string, unknown | null>;
  budget: EveBudgetState;
  logs: string[];
  createdAt: number;
  updatedAt: number;
  finalResult?: unknown;
  error?: string;
  /** When require_approval was skipped or already approved. */
  approvedAt?: number;
  /** Active host.ask / blocked-return question (if status is waiting_user). */
  pendingAsk?: EvePendingAsk;
  /** Prior ask answers keyed by question+options hash (resume-safe). */
  askCache?: Record<string, EveAskAnswer>;
};

export type EveMeta = {
  name: string;
  description: string;
  phases?: { title: string }[];
};

export type EveAgentOptions = {
  schema?: Record<string, unknown>;
  label?: string;
  phase?: string;
  model?: string;
  agent?: string;
  isolation?: "worktree" | "none";
  role?: string;
  timeout_sec?: number;
  permission_mode?: string;
};

export type EveConfig = {
  enabled?: boolean;
  maxAgentsPerRun?: number;
  maxConcurrent?: number;
  schemaRetries?: number;
  requireApproval?: boolean;
  digestIntervalSec?: number;
  defaultPermission?: string;
  /** Default agent id for leaf agent() calls. */
  defaultAgent?: string;
};

export const DEFAULT_EVE_CONFIG: Required<
  Pick<
    EveConfig,
    | "enabled"
    | "maxAgentsPerRun"
    | "maxConcurrent"
    | "schemaRetries"
    | "requireApproval"
    | "digestIntervalSec"
    | "defaultAgent"
  >
> = {
  enabled: true,
  maxAgentsPerRun: 100,
  maxConcurrent: 4,
  schemaRetries: 2,
  requireApproval: true,
  digestIntervalSec: 300,
  defaultAgent: "grok-build",
};

export const eveAgentResultSchema = z.object({
  status: z.enum(["done", "blocked"]).optional(),
  summary: z.string().optional(),
  prUrl: z.string().optional(),
  branch: z.string().optional(),
  data: z.unknown().optional(),
});
