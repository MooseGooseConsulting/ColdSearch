import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "../config.js";
import { resolveGatewayConfig, type GatewayConfig, type GatewayMode } from "./config.js";
import { GatewayCore } from "./core.js";
import { createGatewayServer } from "./server.js";
import { loadSkills, type GatewaySkill } from "./skills.js";

export const GATEWAY_HELP = `coldsearch mcp - MCP gateway in front of search providers' own MCP servers

Usage:
  coldsearch mcp [options]            Serve one agent over stdio
  coldsearch mcp --http [options]     Serve many agents over HTTP at /mcp

Options:
  -c, --config PATH   Config file with a [gateway] section
  --mode all|lazy     all: list every upstream tool; lazy: find/describe/call tools
                      (overrides [gateway] mode)
  --http              Serve streamable HTTP instead of stdio
  --host HOST         HTTP bind address (default: 127.0.0.1)
  --port N            HTTP port (default: 8787)
  -h, --help          Show this help

HTTP mode requires COLDSEARCH_GATEWAY_TOKEN when the bind address is not
loopback; clients then send "Authorization: Bearer <token>".
`;

interface GatewayCliOptions {
  configPath?: string;
  mode?: GatewayMode;
  http: boolean;
  host: string;
  port: number;
  help: boolean;
}

export function parseGatewayArgs(args: string[]): GatewayCliOptions {
  const options: GatewayCliOptions = { http: false, host: "127.0.0.1", port: 8787, help: false };
  const value = (index: number, flag: string): string => {
    const next = args[index + 1];
    if (next === undefined || next.startsWith("-")) throw new Error(`${flag} requires a value`);
    return next;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "-c":
      case "--config":
        options.configPath = value(i++, arg);
        break;
      case "--mode": {
        const mode = value(i++, arg);
        if (mode !== "all" && mode !== "lazy") throw new Error('--mode must be "all" or "lazy"');
        options.mode = mode;
        break;
      }
      case "--http":
        options.http = true;
        break;
      case "--host":
        options.host = value(i++, arg);
        break;
      case "--port": {
        const port = Number(value(i++, arg));
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1-65535");
        options.port = port;
        break;
      }
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option for mcp: ${arg}`);
    }
  }
  return options;
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Serve the gateway over streamable HTTP. One MCP session per connected
 * agent, all sharing `core`. Resolves once the server is listening.
 */
export async function startHttpGateway(
  core: GatewayCore,
  skills: GatewaySkill[],
  options: { host: string; port: number; token?: string }
): Promise<HttpServer> {
  if (!options.token && !isLoopback(options.host)) {
    throw new Error(
      `Refusing to serve on ${options.host} without a token: set COLDSEARCH_GATEWAY_TOKEN, or bind to 127.0.0.1`
    );
  }
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz") {
      send(res, 200, { ok: true });
      return;
    }
    if (path !== "/mcp") {
      send(res, 404, { error: "Not found; the MCP endpoint is /mcp" });
      return;
    }
    if (options.token && !tokenMatches(req.headers.authorization, options.token)) {
      send(res, 401, { error: "Missing or wrong bearer token" });
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }
    if (typeof sessionId === "string") {
      send(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Unknown session; reconnect" }, id: null });
      return;
    }
    if (req.method !== "POST") {
      send(res, 400, { jsonrpc: "2.0", error: { code: -32000, message: "Start with an initialize POST" }, id: null });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await createGatewayServer(core, skills).connect(transport);
    await transport.handleRequest(req, res);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      process.stderr.write(`coldsearch gateway: request failed (${(error as Error).message})\n`);
      if (!res.headersSent) send(res, 500, { error: "Internal gateway error" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  return server;
}

/** Entry point for `coldsearch mcp`. */
export async function runGatewayCli(args: string[]): Promise<void> {
  const options = parseGatewayArgs(args);
  if (options.help) {
    console.log(GATEWAY_HELP);
    return;
  }

  const raw = (loadConfig(options.configPath) as unknown as { gateway?: unknown }).gateway;
  const config: GatewayConfig = resolveGatewayConfig(raw);
  if (options.mode) config.mode = options.mode;

  const core = new GatewayCore(config);
  const skills = loadSkills(config.skillsDir);
  // stdout carries the protocol in stdio mode, so all operator output is stderr.
  const note = (message: string) => process.stderr.write(`coldsearch gateway: ${message}\n`);
  const summary = `${config.upstreams.length} upstreams (${config.upstreams.map((u) => u.name).join(", ")}), ${skills.length} skills, mode ${config.mode}, native tools ${config.native.enabled ? "on" : "off"}, ledger ${config.ledgerPath}`;

  if (options.http) {
    const token = process.env.COLDSEARCH_GATEWAY_TOKEN?.trim() || undefined;
    const server = await startHttpGateway(core, skills, { host: options.host, port: options.port, token });
    note(`listening on http://${options.host}:${options.port}/mcp${token ? " (bearer token required)" : ""}; ${summary}`);
    const stop = () => {
      server.close();
      void core.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }

  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void core.close().finally(() => process.exit(0));
  };
  await createGatewayServer(core, skills).connect(transport);
  note(`serving on stdio; ${summary}`);
}
