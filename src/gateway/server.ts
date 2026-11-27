import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { APP_VERSION } from "../app.js";
import { NAME_SEPARATOR, type GatewayCore, type GatewayTool } from "./core.js";
import type { GatewaySkill } from "./skills.js";

const STATUS_TOOL = "coldsearch_status";
const FIND_TOOL = "coldsearch_find_tools";
const DESCRIBE_TOOL = "coldsearch_describe_tool";
const CALL_TOOL = "coldsearch_call_tool";
const SKILL_TOOL = "coldsearch_read_skill";

const FIND_LIMIT = 15;
const SUMMARY_CHARS = 280;

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function ownTools(core: GatewayCore, skills: GatewaySkill[]): Tool[] {
  const tools: Tool[] = [
    {
      name: STATUS_TOOL,
      description:
        "Report the gateway's upstreams, which key each is using, keys skipped for being out of credit, and calls and cost per upstream and key over the last 24 hours and 7 days. Read this before a search-heavy task to see which allowances are low.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
  ];
  if (skills.length > 0) {
    tools.push({
      name: SKILL_TOOL,
      description: `Read a curated skill by name. Available: ${skills.map((skill) => `${skill.name} (${skill.description})`).join("; ")}`,
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", enum: skills.map((skill) => skill.name) } },
        required: ["name"],
      },
      annotations: { readOnlyHint: true },
    });
  }
  if (core.config.mode === "lazy") {
    tools.push(
      {
        name: FIND_TOOL,
        description: `Search the tools of every upstream by keyword (name and description). Returns up to ${FIND_LIMIT} matches with a short summary each. Leave query empty to list one upstream's tools.`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Words to match, e.g. \"crawl site\" or \"paper search\"." },
            upstream: { type: "string", description: "Limit to one upstream." },
          },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: DESCRIBE_TOOL,
        description: "Return one upstream tool's full description and input schema. Call this before the first use of a tool.",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
        annotations: { readOnlyHint: true },
      },
      {
        name: CALL_TOOL,
        description: `Call an upstream tool by its gateway name (<upstream>${NAME_SEPARATOR}<tool>) with the arguments its schema requires.`,
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" }, arguments: { type: "object" } },
          required: ["name"],
        },
      }
    );
  }
  return tools;
}

function findTools(all: GatewayTool[], query: string, upstream?: string): string {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = all
    .filter((entry) => !upstream || entry.upstream === upstream)
    .map((entry) => {
      const name = entry.name.toLowerCase();
      const description = (entry.tool.description ?? "").toLowerCase();
      let score = 0;
      for (const word of words) {
        if (name.includes(word)) score += 3;
        else if (description.includes(word)) score += 1;
      }
      return { entry, score };
    })
    .filter(({ score }) => words.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

  if (scored.length === 0) {
    const upstreams = [...new Set(all.map((entry) => entry.upstream))].join(", ");
    return `No tools match. Upstreams: ${upstreams}. Try fewer or different words.`;
  }
  const lines = scored.slice(0, FIND_LIMIT).map(({ entry }) => {
    const summary = (entry.tool.description ?? "").replace(/\s+/g, " ").slice(0, SUMMARY_CHARS);
    return `- ${entry.name}: ${summary}`;
  });
  if (scored.length > FIND_LIMIT) lines.push(`(${scored.length - FIND_LIMIT} more; narrow the query or pass upstream)`);
  return lines.join("\n");
}

/** Instructions sent to each agent at connect time. */
export function buildInstructions(core: GatewayCore, skills: GatewaySkill[]): string {
  const upstreams = core.config.upstreams.map((upstream) => upstream.name).join(", ");
  const lines = [
    `ColdSearch gateway: one connection to the web search, fetch, crawl and research tools of ${upstreams}.`,
    `Tool names are <upstream>${NAME_SEPARATOR}<tool>. Every call is logged, and the gateway picks which account's key to use.`,
  ];
  if (core.config.mode === "lazy") {
    lines.push(`Upstream tools are not listed up front: use ${FIND_TOOL}, then ${DESCRIBE_TOOL}, then ${CALL_TOOL}.`);
  }
  lines.push(`${STATUS_TOOL} shows which allowances are low or exhausted.`);
  if (skills.length > 0) {
    lines.push(`Before choosing a tool, read the matching skill with ${SKILL_TOOL}:`);
    for (const skill of skills) lines.push(`- ${skill.name}: ${skill.description}`);
  }
  return lines.join("\n");
}

/**
 * Build the MCP server one connected agent talks to. Each connection gets its
 * own server; they all share `core`.
 */
export function createGatewayServer(core: GatewayCore, skills: GatewaySkill[]): Server {
  const session = randomUUID();
  const server = new Server(
    { name: "coldsearch-gateway", version: APP_VERSION },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: buildInstructions(core, skills),
    }
  );

  const context = () => {
    const client = server.getClientVersion();
    return { session, client: client ? `${client.name}/${client.version}` : undefined };
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const own = ownTools(core, skills);
    if (core.config.mode === "lazy") return { tools: own };
    const upstream = await core.listTools();
    return { tools: [...own, ...upstream.map((entry) => ({ ...entry.tool, name: entry.name }))] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name === STATUS_TOOL) {
      return text(JSON.stringify(await core.readStatus(), null, 2));
    }
    if (name === SKILL_TOOL) {
      const skill = skills.find((candidate) => candidate.name === args.name);
      return skill
        ? text(skill.body)
        : text(`No skill named "${String(args.name)}". Available: ${skills.map((candidate) => candidate.name).join(", ")}.`, true);
    }
    if (core.config.mode === "lazy") {
      if (name === FIND_TOOL) {
        return text(
          findTools(
            await core.listTools(),
            typeof args.query === "string" ? args.query : "",
            typeof args.upstream === "string" ? args.upstream : undefined
          )
        );
      }
      if (name === DESCRIBE_TOOL) {
        const found = (await core.listTools()).find((entry) => entry.name === args.name);
        return found
          ? text(JSON.stringify({ ...found.tool, name: found.name }, null, 2))
          : text(`No tool named "${String(args.name)}". Use ${FIND_TOOL} to search.`, true);
      }
      if (name === CALL_TOOL) {
        if (typeof args.name !== "string") return text(`${CALL_TOOL} needs a tool name.`, true);
        const inner = args.arguments;
        const innerArgs = inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>) : {};
        return core.callTool(args.name, innerArgs, context());
      }
    }
    return core.callTool(name, args, context());
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: skills.map((skill) => ({ name: skill.name, description: skill.description })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const skill = skills.find((candidate) => candidate.name === request.params.name);
    if (!skill) throw new Error(`Unknown skill: ${request.params.name}`);
    return {
      description: skill.description,
      messages: [{ role: "user" as const, content: { type: "text" as const, text: skill.body } }],
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: skills.map((skill) => ({
      uri: `skill://${skill.name}`,
      name: skill.name,
      description: skill.description,
      mimeType: "text/markdown",
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const skill = skills.find((candidate) => `skill://${candidate.name}` === request.params.uri);
    if (!skill) throw new Error(`Unknown resource: ${request.params.uri}`);
    return { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text: skill.body }] };
  });

  return server;
}
