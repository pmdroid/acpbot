import { fakeClock } from "./clock";
import { fakeAgents, type FakeAgentsOptions } from "./fake-agents";
import { fakeTelegram, type FakeTelegramOptions } from "./fake-telegram";
import { silentLogger } from "./logger";
import { memoryStore } from "./store";
import type { Environment, Logger, Store, TacpConfig } from "./types";

export type FakeEnvironment = Environment & {
  telegram: ReturnType<typeof fakeTelegram>;
  agents: ReturnType<typeof fakeAgents>;
  clock: ReturnType<typeof fakeClock>;
  store: Store;
  log: Logger;
};

export type FakeEnvironmentOptions = {
  config?: Partial<TacpConfig>;
  telegram?: FakeTelegramOptions;
  agents?: FakeAgentsOptions;
  store?: Store;
  clockStartMs?: number;
  log?: Logger;
};

/**
 * Full fake Environment for tests. Drive the real daemon core through this
 * and assert on outbound Telegram calls — never mock internal modules.
 */
export function createFakeEnvironment(
  options: FakeEnvironmentOptions = {},
): FakeEnvironment {
  const config: TacpConfig = {
    operatorUserId: options.config?.operatorUserId ?? 42,
    operatorChatId: options.config?.operatorChatId,
    repos: options.config?.repos ?? {
      tacp: "/configured/repos/tacp",
      acpx: "/configured/repos/acpx",
    },
    defaultAgent: options.config?.defaultAgent ?? "codex",
    skillRoots: options.config?.skillRoots,
  };

  const agents = fakeAgents({
    repos: config.repos,
    ...options.agents,
  });

  return {
    config,
    telegram: fakeTelegram(options.telegram),
    agents,
    clock: fakeClock(options.clockStartMs ?? 1_000_000),
    store: options.store ?? memoryStore(),
    log: options.log ?? silentLogger(),
  };
}
