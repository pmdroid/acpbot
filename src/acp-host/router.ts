/**
 * Route Sessions to local Unix or remote WSS acp-host endpoints.
 * Sticky host id is decided by caller (session record / repo binding).
 */
import type { Logger } from "../env/logger";
import { silentLogger } from "../env/logger";
import type { SessionHost, SessionHostHooks } from "../acp/session-host";
import {
  createAcpHostClient,
  resolveAcpHostSockPath,
  type AcpHostClientApi,
} from "./client";
import type { ComputerFrameEvent } from "./protocol";
import {
  getHostEndpoint,
  type HostsCatalog,
  type HostEndpointConfig,
} from "./hosts";

export type HostRouterOptions = {
  catalog: HostsCatalog;
  stateDir?: string;
  log?: Logger;
  hooks?: SessionHostHooks;
  onComputerFrame?: (msg: ComputerFrameEvent) => void;
  onComputerStatus?: (msg: { sessionKey: string; text: string }) => void;
};

export type HostRouter = {
  /** SessionHost for a host id (creates client lazily). */
  getHost(hostId: string): SessionHost;
  /** Apply hooks to all live clients. */
  setHooks(hooks: SessionHostHooks): void;
  setComputerHandlers(handlers: {
    onComputerFrame?: (msg: ComputerFrameEvent) => void;
    onComputerStatus?: (msg: { sessionKey: string; text: string }) => void;
  }): void;
  catalog: HostsCatalog;
};

export function createHostRouter(options: HostRouterOptions): HostRouter {
  const log = (options.log ?? silentLogger()).child("host-router");
  const clients = new Map<string, AcpHostClientApi>();
  let hooks: SessionHostHooks = { ...options.hooks };
  let onComputerFrame = options.onComputerFrame;
  let onComputerStatus = options.onComputerStatus;

  function buildClient(ep: HostEndpointConfig): AcpHostClientApi {
    const computer = {
      onComputerFrame: (msg: ComputerFrameEvent) => onComputerFrame?.(msg),
      onComputerStatus: (msg: { sessionKey: string; text: string }) =>
        onComputerStatus?.(msg),
    };
    if (ep.kind === "wss") {
      log.info("create remote host client", { hostId: ep.id, url: ep.url });
      return createAcpHostClient({
        log,
        hooks,
        ...(ep.url ? { url: ep.url } : {}),
        ...(ep.token ? { token: ep.token } : {}),
        ...computer,
      });
    }
    const sockPath =
      ep.sockPath?.trim() ||
      resolveAcpHostSockPath(options.stateDir);
    log.info("create local host client", { hostId: ep.id, sockPath });
    return createAcpHostClient({
      log,
      hooks,
      sockPath,
      ...computer,
    });
  }

  return {
    catalog: options.catalog,
    getHost(hostId: string) {
      const id = hostId.trim() || "local";
      let client = clients.get(id);
      if (client) return client;
      const ep = getHostEndpoint(options.catalog, id);
      client = buildClient(ep);
      clients.set(id, client);
      return client;
    },
    setHooks(next) {
      hooks = { ...hooks, ...next };
      for (const c of clients.values()) {
        c.setHooks(hooks);
      }
    },
    setComputerHandlers(next) {
      if (next.onComputerFrame !== undefined) {
        onComputerFrame = next.onComputerFrame;
      }
      if (next.onComputerStatus !== undefined) {
        onComputerStatus = next.onComputerStatus;
      }
    },
  };
}
