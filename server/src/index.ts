import { createSyncServer } from "./app.js";
import { loadAdminConfig, loadAdminUiConfig } from "./config/admin-config.js";
import { parseIntegerEnv } from "./config/env.js";
import { loadPersistenceConfig } from "./config/persistence-config.js";
import { loadSecurityConfig } from "./config/security-config.js";

const port = parseIntegerEnv(process.env, "PORT", 8787);
const securityConfig = loadSecurityConfig();
const persistenceConfig = loadPersistenceConfig();
const adminConfig = loadAdminConfig();
const adminUiConfig = loadAdminUiConfig();

const { httpServer } = await createSyncServer(
  securityConfig,
  persistenceConfig,
  {
    adminConfig,
    adminUiConfig,
  },
);
httpServer.listen(port, () => {
  console.log(`Bili-SyncPlay server listening on http://localhost:${port}`);
});
