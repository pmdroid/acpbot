/**
 * OpenAI /v1/models catalog from configured repos × agent ids.
 */
import type { OpenAiModel } from "./types";
import { listRegisteredAgents } from "../acp/agent-launch";

export type ModelCatalogOptions = {
  repos: Record<string, string>;
  /** Limit agents (config allowlist). Empty = discover from PATH. */
  agents?: string[];
  /** Limit repos. Empty = all configured repos. */
  repoKeys?: string[];
  defaultAgent?: string;
};

export function buildModelCatalog(opts: ModelCatalogOptions): OpenAiModel[] {
  const created = Math.floor(Date.now() / 1000);
  const repoKeys =
    opts.repoKeys?.length ? opts.repoKeys : Object.keys(opts.repos);
  let agents = opts.agents?.filter(Boolean) ?? [];
  if (agents.length === 0) {
    try {
      agents = listRegisteredAgents({ availableOnly: true });
    } catch {
      agents = opts.defaultAgent ? [opts.defaultAgent] : ["grok-build"];
    }
  }
  if (agents.length === 0) {
    agents = [opts.defaultAgent || "grok-build"];
  }

  const out: OpenAiModel[] = [];
  for (const repo of repoKeys) {
    if (!opts.repos[repo]) continue;
    for (const agent of agents) {
      out.push({
        id: `acpbot/${repo}/${agent}`,
        object: "model",
        created,
        owned_by: "acpbot",
      });
    }
  }
  // Shorthand agent-only ids when a default repo is implied by caller
  return out;
}
