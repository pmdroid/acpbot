/**
 * In-repo schedule job schema (`<repo>/.tacp/schedules/<id>.json`).
 *
 * Host fire (acp-host) is out of scope for A2 — this is durable CRUD only.
 */
import { z } from "zod";

export const scheduleJobStatusSchema = z.enum([
  "ok",
  "error",
  "skipped",
  "busy",
]);

export type ScheduleJobStatus = z.infer<typeof scheduleJobStatusSchema>;

export const scheduleJobKindSchema = z.enum(["once", "cron"]);

export type ScheduleJobKind = z.infer<typeof scheduleJobKindSchema>;

export const scheduleJobSchema = z.object({
  id: z.string().min(1),
  sessionKey: z.string().min(1),
  name: z.string().min(1).optional(),
  /** Full agent instruction at fire time — always required. */
  prompt: z.string().min(1),
  /** Optional path relative to repo root (must stay inside repo). */
  script: z.string().min(1).optional(),
  kind: scheduleJobKindSchema,
  cronExpr: z.string().min(1).optional(),
  timezone: z.string().min(1).optional(),
  /** ISO timestamp for kind === "once". */
  runAt: z.string().min(1).optional(),
  /** ISO timestamp — next (or only) fire time. */
  nextRunAt: z.string().min(1),
  enabled: z.boolean(),
  lastRunAt: z.string().nullable().optional(),
  lastStatus: scheduleJobStatusSchema.nullable().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type ScheduleJob = z.infer<typeof scheduleJobSchema>;

export type CreateScheduleInput = {
  sessionKey: string;
  name?: string;
  prompt: string;
  script?: string;
  kind: ScheduleJobKind;
  cronExpr?: string;
  runAt?: string;
  timezone?: string;
  /** Override clock (tests). Default: now. */
  now?: Date;
};
