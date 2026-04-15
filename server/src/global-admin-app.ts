import { createServer, type Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createGlobalAdminOverviewService } from "./admin/global-overview-service.js";
import { createGlobalAdminRoomQueryService } from "./admin/global-room-query-service.js";
import { createAdminServices } from "./bootstrap/admin-services.js";
import {
  createServerBootstrapContext,
  createSharedServerShutdownSteps,
  getDefaultPersistenceConfig,
  getDefaultSecurityConfig,
  runShutdownSteps,
} from "./bootstrap/server-bootstrap.js";
import { createHttpRequestHandler } from "./bootstrap/http-handler.js";
import { type RoomStore } from "./room-store.js";
import { createRoomService } from "./room-service.js";
import type { RoomEventBusMessage } from "./room-event-bus.js";
import { createRuntimeIndexReaper } from "./runtime-index-reaper.js";
import { createSecurityPolicy } from "./security.js";
import type {
  AdminConfig,
  AdminUiConfig,
  LogEvent,
  PersistenceConfig,
  SecurityConfig,
} from "./types.js";

export type GlobalAdminServer = {
  httpServer: HttpServer;
  close: () => Promise<void>;
};

export type GlobalAdminServerDependencies = {
  roomStore?: RoomStore;
  logEvent?: LogEvent;
  generateToken?: () => string;
  now?: () => number;
  adminConfig?: AdminConfig;
  adminUiConfig?: AdminUiConfig;
  serviceVersion?: string;
};

export async function createGlobalAdminServer(
  securityConfig: SecurityConfig = getDefaultSecurityConfig(),
  persistenceConfig: PersistenceConfig = getDefaultPersistenceConfig(),
  dependencies: GlobalAdminServerDependencies = {},
): Promise<GlobalAdminServer> {
  const now = dependencies.now ?? Date.now;
  const generateToken =
    dependencies.generateToken ?? (() => randomBytes(24).toString("base64url"));
  const {
    serviceVersion,
    roomStore,
    runtimeStore,
    adminCommandBus,
    roomEventBus,
    eventStore,
    logEvent,
  } = await createServerBootstrapContext(persistenceConfig, dependencies, {
    useMirroredRuntimeStore: false,
  });
  const roomService = createRoomService({
    config: securityConfig,
    persistence: persistenceConfig,
    roomStore,
    runtimeStore,
    generateToken,
    logEvent,
    now,
  });
  const securityPolicy = createSecurityPolicy(securityConfig);
  const { adminRouter, close: closeAdminServices } = await createAdminServices({
    securityConfig,
    persistenceConfig,
    roomStore,
    runtimeStore,
    eventStore,
    roomService,
    send() {},
    publishRoomEvent: (message: RoomEventBusMessage) =>
      roomEventBus.publish(message),
    requestAdminCommand: (command, timeoutMs) =>
      adminCommandBus.request(command, timeoutMs),
    logEvent,
    now,
    adminConfig: dependencies.adminConfig,
    serviceName: "bili-syncplay-global-admin",
    createOverviewService: createGlobalAdminOverviewService,
    createRoomQueryService: createGlobalAdminRoomQueryService,
    serviceVersion,
  });
  const runtimeIndexReaper = createRuntimeIndexReaper({
    enabled:
      persistenceConfig.nodeHeartbeatEnabled &&
      persistenceConfig.runtimeStoreProvider === "redis",
    runtimeStore,
    intervalMs: persistenceConfig.nodeHeartbeatIntervalMs,
    now,
    logEvent,
  });
  runtimeIndexReaper.start();

  const httpServer = createServer(
    createHttpRequestHandler({
      adminRouter,
      securityPolicy,
      adminUiConfig: dependencies.adminUiConfig,
    }),
  );

  return {
    httpServer,
    close: () =>
      runShutdownSteps(
        [
          {
            name: "close_http_server",
            run: () =>
              new Promise<void>((resolve, reject) => {
                httpServer.close((error) => {
                  if (error) {
                    reject(error);
                    return;
                  }
                  resolve();
                });
              }),
          },
          {
            name: "stop_runtime_index_reaper",
            run: () => runtimeIndexReaper.stop(),
          },
          ...createSharedServerShutdownSteps({
            roomStore,
            eventStore,
            runtimeStore,
            adminCommandBus,
            roomEventBus,
            closeAdminServices,
          }),
        ],
        logEvent,
      ),
  };
}
