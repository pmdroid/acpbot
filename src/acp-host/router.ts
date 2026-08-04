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
} from "./client";
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
};

export type HostRouter = {
  /** SessionHost for a host id (creates client lazily). */
  getHost(hostId: string): SessionHost;
  /** Apply hooks to all live clients. */
  setHooks(hooks: SessionHostHooks): void;
  catalog: HostsCatalog;
};

export function createHostRouter(options: HostRouterOptions): HostRouter {
  const log = (options.log ?? silentLogger()).child("host-router");
  const clients = new Map<string, SessionHost>();
  let hooks: SessionHostHooks = { ...options.hooks };

  function buildClient(ep: HostEndpointConfig): SessionHost {
    if (ep.kind === "wss") {
      log.info("create remote host client", { hostId: ep.id, url: ep.url });
      return createAcpHostClient({
        log,
        hooks,
        url: ep.url,
        token: ep.token,
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
  };
}
