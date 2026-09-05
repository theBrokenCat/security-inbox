import { EventEmitter } from 'node:events';

import type { FastifyInstance } from 'fastify';
import { describe, expect, test } from 'vitest';

import type { SecurityInboxService } from '../../src/core/service.js';
import { startWebServer } from '../../src/web/server.js';

function serviceDouble(close: () => void): SecurityInboxService {
  return { close } as SecurityInboxService;
}

function appDouble(
  listen: (options: unknown) => Promise<string>,
  close: () => Promise<void>,
): FastifyInstance {
  return { listen, close } as unknown as FastifyInstance;
}

describe('web server lifecycle', () => {
  test('closes the service if app construction fails', async () => {
    const signals = new EventEmitter();
    let serviceCloses = 0;

    await expect(startWebServer({
      createService: () => serviceDouble(() => { serviceCloses += 1; }),
      createApp: () => { throw new Error('build failed'); },
      signals,
    })).rejects.toThrow('build failed');

    expect(serviceCloses).toBe(1);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  test('closes both resources if listen fails', async () => {
    const signals = new EventEmitter();
    const closed: string[] = [];

    await expect(startWebServer({
      createService: () => serviceDouble(() => { closed.push('service'); }),
      createApp: () => appDouble(
        async () => { throw new Error('listen failed'); },
        async () => { closed.push('app'); return undefined; },
      ),
      signals,
    })).rejects.toThrow('listen failed');

    expect(closed).toEqual(['app', 'service']);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });

  test.each(['SIGINT', 'SIGTERM'] as const)('%s drains app and service exactly once', async (signal) => {
    const signals = new EventEmitter();
    const closed: string[] = [];
    let listened: unknown;
    let releaseClose!: () => void;
    const closeStarted = new Promise<void>((resolve) => { releaseClose = resolve; });

    const running = await startWebServer({
      createService: () => serviceDouble(() => { closed.push('service'); }),
      createApp: () => appDouble(
        async (options) => { listened = options; return 'listening'; },
        async () => { closed.push('app'); releaseClose(); return undefined; },
      ),
      environment: { SECURITY_INBOX_CONTAINER: 'false' },
      signals,
    });

    expect(listened).toEqual({ host: '127.0.0.1', port: 3300 });
    signals.emit(signal);
    signals.emit(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
    await closeStarted;
    await running.shutdown();

    expect(closed).toEqual(['app', 'service']);
    expect(signals.listenerCount('SIGINT')).toBe(0);
    expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
});
