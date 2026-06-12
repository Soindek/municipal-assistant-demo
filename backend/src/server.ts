import { loadTenantConfig } from '@municipal-assistant/config';
import { createApp } from './api/app.js';
import { getEnv } from './env.js';
import { createLlmClients } from './llm/index.js';
import { consoleLogger } from './logger.js';

function main(): void {
  const env = getEnv();
  const config = loadTenantConfig(env.TENANT_ID);
  const llm = createLlmClients(config);
  const app = createApp({ config, llm, env });

  app.listen(env.PORT, () => {
    consoleLogger.info(
      `Backend fut: http://localhost:${env.PORT}  (tenant=${config.tenantId}, chatModel=${config.rag.chatModel})`,
    );
  });
}

main();
