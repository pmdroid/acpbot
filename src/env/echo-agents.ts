import type {
  AgentSessionHandle,
  AgentsPort,
  PromptTurn,
  PromptTurnInput,
  SessionIdentity,
  TacpConfig,
} from "./types";

/**
 * No-process agent backend for proving the Telegram surface without a
 * logged-in coding agent. Replies with an echo so the operator sees a full
 * loop: topic → prompt → status → final message.
 */
export function echoAgents(config: TacpConfig): AgentsPort {
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
          `unknown repo "${identity.repo}" — add it to TACP_REPOS_JSON`,
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
        `(cwd=${handle.cwd}; agent backend=echo — set TACP_AGENT_BACKEND=real for ACP)`;

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
