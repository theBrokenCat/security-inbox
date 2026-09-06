import type { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { SecurityInboxService } from '../core/service.js';
import { ProjectDirectoryManager } from '../projects/directory-manager.js';
import { buildWebApp, resolveListenHost } from './app.js';

type StartWebServerOptions = {
  environment?: NodeJS.ProcessEnv;
  port?: number;
  createService?: (databasePath?: string) => SecurityInboxService;
  createApp?: typeof buildWebApp;
  signals?: Pick<EventEmitter, 'once' | 'off'>;
};

type RunningWebServer = {
  shutdown: () => Promise<void>;
};

export async function startWebServer({
  environment = process.env,
  port = 3300,
  createService = (databasePath) => new SecurityInboxService(databasePath),
  createApp = buildWebApp,
  signals = process,
}: StartWebServerOptions = {}): Promise<RunningWebServer> {
  let service: SecurityInboxService | undefined;
  let app: FastifyInstance | undefined;
  let closing: Promise<void> | undefined;
  let listening = false;

  const removeSignalListeners = () => {
    if (!listening) return;
    signals.off('SIGINT', onSignal);
    signals.off('SIGTERM', onSignal);
    listening = false;
  };
  const shutdown = () => {
    closing ??= (async () => {
      try {
        await app?.close();
      } finally {
        try {
          service?.close();
        } finally {
          removeSignalListeners();
        }
      }
    })();
    return closing;
  };
  const onSignal = () => {
    void shutdown().catch(() => {
      console.error('Security Inbox could not shut down cleanly.');
      process.exitCode = 1;
    });
  };

  try {
    service = createService(environment.SECURITY_INBOX_DB);
    const directories = new ProjectDirectoryManager(service, {
      accessibleRoot: environment.SECURITY_INBOX_PROJECTS_ROOT,
      displayRoot: environment.SECURITY_INBOX_PROJECTS_DISPLAY_ROOT,
    });
    app = createApp({ service, directories, port });
    await app.listen({ host: resolveListenHost(environment), port });
    listening = true;
    signals.once('SIGINT', onSignal);
    signals.once('SIGTERM', onSignal);
    return { shutdown };
  } catch (error) {
    try {
      await shutdown();
    } catch {
      // Preserve the construction/listen failure; cleanup was still attempted.
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startWebServer().catch(() => {
    console.error('Security Inbox web server could not start.');
    process.exitCode = 1;
  });
}
