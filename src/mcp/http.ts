import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { SecurityInboxService } from '../core/service.js';
import type { ProjectDirectoryManager } from '../projects/directory-manager.js';
import { createSecurityInboxMcpServer } from './factory.js';
import { userForAuthorization, type McpTokens } from './tokens.js';

// MCP over streamable HTTP for clients that cannot start a process over SSH. Same tools and
// rules as stdio; a fresh server per request, built for the user the bearer token names.
// Path, Origin and token are checked from the headers before a byte of the body is read, so
// an unauthenticated client cannot hold memory. A DNS-rebinding page could set the header,
// but it does not know a token; browsers also send Origin, which is refused unless listed.
// The traffic is plain HTTP: publish it beyond loopback only over a trusted link (VPN/TLS).

const mcpPath = '/mcp';
const maximumBodyBytes = 1024 * 1024;

export type HttpMcpGate = { status: number; body: { error: string }; headers?: Record<string, string> } | { userSlug: string };

/** Decides from the request line and headers alone whether a request may reach MCP. */
export function gateHttpMcpRequest(
  tokens: McpTokens,
  allowedOrigins: ReadonlySet<string>,
  pathname: string,
  headers: { authorization?: string | null; origin?: string | null; contentLength?: string | null },
): HttpMcpGate {
  if (pathname !== mcpPath) return { status: 404, body: { error: 'Not found' } };
  if (headers.origin && !allowedOrigins.has(headers.origin)) return { status: 403, body: { error: 'Origin not allowed' } };
  const userSlug = userForAuthorization(tokens, headers.authorization ?? null);
  if (!userSlug) {
    return {
      status: 401,
      body: { error: 'A valid bearer token is required' },
      headers: { 'www-authenticate': 'Bearer realm="security-inbox"' },
    };
  }
  if (Number(headers.contentLength ?? 0) > maximumBodyBytes) return { status: 413, body: { error: 'Payload too large' } };
  return { userSlug };
}

export function createHttpMcpFetch(
  service: SecurityInboxService,
  directories: ProjectDirectoryManager,
  tokens: McpTokens,
  allowedOrigins: ReadonlySet<string> = new Set(),
): (request: Request) => Promise<Response> {
  const handler = createMcpHandler((context) => createSecurityInboxMcpServer(service, directories, {
    userSlug: typeof context.authInfo?.extra?.userSlug === 'string' ? context.authInfo.extra.userSlug : undefined,
  }));

  return async (request) => {
    const gate = gateHttpMcpRequest(tokens, allowedOrigins, new URL(request.url).pathname, {
      authorization: request.headers.get('authorization'),
      origin: request.headers.get('origin'),
      contentLength: request.headers.get('content-length'),
    });
    if (!('userSlug' in gate)) return Response.json(gate.body, { status: gate.status, headers: gate.headers });
    return handler.fetch(request, {
      authInfo: { token: 'redacted', clientId: gate.userSlug, scopes: [], extra: { userSlug: gate.userSlug } },
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
  // pipeline tears both ends down on error or client disconnect instead of crashing.
  await pipeline(stream, outgoing).catch(() => undefined);
}

export type RunningHttpMcp = { server: Server; url: string; close: () => Promise<void> };

export async function startHttpMcpServer(options: {
  service: SecurityInboxService;
  directories: ProjectDirectoryManager;
  tokens: McpTokens;
  host: string;
  port: number;
  allowedOrigins?: ReadonlySet<string>;
  maxConnections?: number;
}): Promise<RunningHttpMcp> {
  const allowedOrigins = options.allowedOrigins ?? new Set<string>();
  const fetch = createHttpMcpFetch(options.service, options.directories, options.tokens, allowedOrigins);
  const reply = (outgoing: ServerResponse, status: number, body: object, headers: Record<string, string> = {}) => {
    outgoing.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...headers });
    outgoing.end(JSON.stringify(body));
  };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        // Refuse before reading the body: path, Origin, token and declared size come first.
        const pathname = new URL(incoming.url ?? '/', 'http://gate.invalid').pathname;
        const gate = gateHttpMcpRequest(options.tokens, allowedOrigins, pathname, {
          authorization: incoming.headers.authorization,
          origin: incoming.headers.origin,
          contentLength: incoming.headers['content-length'],
        });
        if (!('userSlug' in gate)) {
          reply(outgoing, gate.status, gate.body, gate.headers);
          incoming.resume();
          return;
        }
        let request: Request;
        try {
          request = await toWebRequest(incoming, `http://${incoming.headers.host ?? 'localhost'}`);
        } catch (error) {
          const tooLarge = (error as { status?: number }).status === 413;
          reply(outgoing, tooLarge ? 413 : 400, { error: tooLarge ? 'Payload too large' : 'Bad request' });
          return;
        }
        await sendWebResponse(await fetch(request), outgoing);
      } catch {
        if (!outgoing.headersSent) reply(outgoing, 500, { error: 'Request failed' });
        else outgoing.destroy();
      }
    })();
  });
  // Bounded so slow or idle clients cannot pin memory or sockets.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxConnections = options.maxConnections ?? 64;
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
