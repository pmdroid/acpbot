import type {
  AgentSessionHandle,
  AgentsPort,
  PromptTurn,
  PromptTurnInput,
  SessionIdentity,
  AcpbotConfig,
} from "./types";

/**
 * Test-only no-process agent fake. Not used by the production worker entry
 * (`src/main.ts` always uses `realAgents`). Replies with an echo so tests can
 * exercise topic → prompt → status → final message without a coding agent.
 */
export function echoAgents(config: AcpbotConfig): AgentsPort {
  const sessions = new Map<string, AgentSessionHandle>();
  const abortBySession = new Map<string, AbortController>();
  const sessionModes = new Map<string, string>();
  const ECHO_MODES = ["plan", "build"];
  const sessionKeyOf = (id: SessionIdentity) => `${id.repo}/${id.name}`;

  return {
    async ensureSession(identity) {
      const key = sessionKeyOf(identity);
      const existing = sessions.get(key);
      if (existing) return existing;

      const cwd = config.repos?.[identity.repo];
      if (!cwd) {
        throw new Error(
          `unknown repo "${identity.repo}" — add it with: acpbot repo add ${identity.repo}`,
        );
      }

      const handle: AgentSessionHandle = {
        sessionKey: key,
        identity: { ...identity },
        cwd,
      };
      sessions.set(key, handle);
      return handle;
    },

    async cancelTurn(sessionKey) {
      const ac = abortBySession.get(sessionKey);
      ac?.abort();
      abortBySession.delete(sessionKey);
    },

    async setSessionMode(sessionKey, modeId) {
      sessionModes.set(sessionKey, modeId);
      return { currentModeId: modeId, availableModeIds: [...ECHO_MODES] };
    },

    async getSessionMode(sessionKey) {
      return {
        currentModeId: sessionModes.get(sessionKey) ?? "build",
        availableModeIds: [...ECHO_MODES],
      };
    },

    async runPromptTurn(
      handle: AgentSessionHandle,
      input: PromptTurnInput,
    ): Promise<PromptTurn> {
      const ac = new AbortController();
      abortBySession.set(handle.sessionKey, ac);
      if (input.signal) {
        if (input.signal.aborted) ac.abort();
        else {
          input.signal.addEventListener("abort", () => ac.abort(), {
            once: true,
          });
        }
      }

      const reply =
        `[echo/${handle.identity.repo}] ${input.text}\n` +
        `(cwd=${handle.cwd}; test echoAgents fake)`;

      const events = (async function* () {
        if (ac.signal.aborted) {
          yield { type: "turn_ended" as const, stopReason: "cancelled" };
          return;
        }
        yield { type: "turn_started" as const };
        if (ac.signal.aborted) {
          yield { type: "turn_ended" as const, stopReason: "cancelled" };
          return;
        }
        yield { type: "agent_message_chunk" as const, text: reply };
        yield {
          type: "turn_ended" as const,
          stopReason: ac.signal.aborted ? "cancelled" : "end_turn",
        };
      })();

      return {
        events,
        done: Promise.resolve({
          stopReason: ac.signal.aborted ? "cancelled" : "end_turn",
        }).finally(() => {
          abortBySession.delete(handle.sessionKey);
        }),
      };
    },
  };
}
