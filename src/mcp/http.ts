import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { SecurityInboxService } from '../core/service.js';
import type { ProjectDirectoryManager } from '../projects/directory-manager.js';
import { createSecurityInboxMcpServer } from './factory.js';
import { userForAuthorization, type McpTokens } from './tokens.js';

// MCP over streamable HTTP for clients that cannot start a process over SSH. Same tools and
// rules as stdio; a fresh server per request, built for the user the bearer token names.
// Requests without a known token never reach MCP, which also defeats DNS rebinding: a page
// that tricks a browser into calling this port cannot add the Authorization header.

const mcpPath = '/mcp';
const maximumBodyBytes = 1024 * 1024;

export function createHttpMcpFetch(
  service: SecurityInboxService,
  directories: ProjectDirectoryManager,
  tokens: McpTokens,
): (request: Request) => Promise<Response> {
  const handler = createMcpHandler((context) => createSecurityInboxMcpServer(service, directories, {
    userSlug: typeof context.authInfo?.extra?.userSlug === 'string' ? context.authInfo.extra.userSlug : undefined,
  }));

  return async (request) => {
    if (new URL(request.url).pathname !== mcpPath) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const userSlug = userForAuthorization(tokens, request.headers.get('authorization'));
    if (!userSlug) {
      return Response.json(
        { error: 'A valid bearer token is required' },
        { status: 401, headers: { 'www-authenticate': 'Bearer realm="security-inbox"' } },
      );
    }
    return handler.fetch(request, {
      authInfo: { token: 'redacted', clientId: userSlug, scopes: [], extra: { userSlug } },
    });
  };
}

async function toWebRequest(incoming: IncomingMessage, origin: string): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = incoming.method ?? 'GET';
  let body: Uint8Array | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of incoming) {
      size += (chunk as Buffer).length;
      if (size > maximumBodyBytes) throw Object.assign(new Error('Payload too large'), { status: 413 });
      chunks.push(chunk as Buffer);
    }
    body = new Uint8Array(Buffer.concat(chunks));
  }
  return new Request(new URL(incoming.url ?? '/', origin), { method, headers, ...(body ? { body: body as BodyInit } : {}) });
}

async function sendWebResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  if (!response.body) {
    outgoing.end();
    return;
  }
  const stream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  outgoing.on('close', () => stream.destroy());
  stream.pipe(outgoing);
}

export type RunningHttpMcp = { server: Server; url: string; close: () => Promise<void> };

export async function startHttpMcpServer(options: {
  service: SecurityInboxService;
  directories: ProjectDirectoryManager;
  tokens: McpTokens;
  host: string;
  port: number;
}): Promise<RunningHttpMcp> {
  const fetch = createHttpMcpFetch(options.service, options.directories, options.tokens);
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const request = await toWebRequest(incoming, `http://${incoming.headers.host ?? 'localhost'}`);
        await sendWebResponse(await fetch(request), outgoing);
      } catch (error) {
        const status = (error as { status?: number }).status === 413 ? 413 : 500;
        if (!outgoing.headersSent) {
          outgoing.writeHead(status, { 'content-type': 'application/json' });
          outgoing.end(JSON.stringify({ error: status === 413 ? 'Payload too large' : 'Request failed' }));
        } else {
          outgoing.destroy();
        }
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${address.port}${mcpPath}`,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
