import crypto from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { setTimeout as sleepMs } from "node:timers/promises";

import { Agent } from "@cursor/sdk";

const parseInteger = function parseInteger(value, fallback) {
  const parsed = Math.trunc(Number(String(value || "")));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const isStringValue = function isStringValue(value) {
  return Object.prototype.toString.call(value) === "[object String]";
};

const isNumberValue = function isNumberValue(value) {
  return Object.prototype.toString.call(value) === "[object Number]";
};

const isBooleanValue = function isBooleanValue(value) {
  return Object.prototype.toString.call(value) === "[object Boolean]";
};

const isFunctionValue = function isFunctionValue(value) {
  return ["[object Function]", "[object AsyncFunction]"].includes(
    Object.prototype.toString.call(value)
  );
};

const isSymbolValue = function isSymbolValue(value) {
  return Object.prototype.toString.call(value) === "[object Symbol]";
};

const envEntryFromLine = function envEntryFromLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const normalized = trimmed.startsWith("export ")
    ? trimmed.slice(7).trim()
    : trimmed;
  const equals = normalized.indexOf("=");
  if (equals <= 0) {
    return null;
  }
  const key = normalized.slice(0, equals).trim();
  let value = normalized.slice(equals + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
};

const loadEnvFile = function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }
  for (const line of readFileSync(filePath, "utf-8").split(/\r?\n/u)) {
    const entry = envEntryFromLine(line);
    if (entry && !process.env[entry.key]) {
      process.env[entry.key] = entry.value;
    }
  }
};

const scriptDir = import.meta.dirname;

const repoRoot = path.resolve(scriptDir, "..");

loadEnvFile(path.join(repoRoot, ".env"));

loadEnvFile(path.join(process.cwd(), ".env"));

const host = process.env.CURSOR_SDK_BRIDGE_HOST || "127.0.0.1";

const port = parseInteger(process.env.CURSOR_SDK_BRIDGE_PORT, 8792);

const bridgeToken = process.env.CURSOR_SDK_BRIDGE_TOKEN || "";

const maxJsonBytes = parseInteger(
  process.env.CURSOR_SDK_BRIDGE_MAX_JSON_BYTES,
  1024 * 1024
);

const maxAgents = parseInteger(process.env.CURSOR_SDK_BRIDGE_MAX_AGENTS, 128);

const runTimeoutMs = parseInteger(
  process.env.CURSOR_SDK_BRIDGE_RUN_TIMEOUT_MS,
  180 * 1000
);

const maxRunRetries = parseInteger(
  process.env.CURSOR_SDK_BRIDGE_MAX_RUN_RETRIES,
  3
);

const retryBaseDelayMs = parseInteger(
  process.env.CURSOR_SDK_BRIDGE_RETRY_BASE_DELAY_MS,
  500
);

const defaultCwd = process.env.CURSOR_SDK_WORKING_DIRECTORY || process.cwd();

const composerModel = ["composer", "2.5"].join("-");

const clientMcpServerName = "client";

const clientMcpServerMode = "--client-mcp-server";

const clientToolCallbackPath = "/client-tool-call";

const agentCache = new Map();

const agentRunQueues = new Map();

const activeClientToolCaptures = new Map();

const forceNextRunAgentKeys = new Set();

let server = null;

let normalizeJsonValue = null;

let schemaEvaluatesObjectProperty = null;

let validateJsonSchemaValue = null;

let mcpClientToolPayloadIsComplete = null;

let hasArray = null;

class HttpError extends Error {
  constructor(message, status = 500, code = "api_error") {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.type = status >= 500 ? "api_error" : "invalid_request_error";
  }
}

const ignoreError = function ignoreError() {
  void 0;
};

const writeJson = function writeJson(response, body, status = 200) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache, no-transform",
    "Content-Length": String(data.length),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(data);
};

const bearerToken = function bearerToken(request) {
  const value = request.headers.authorization || "";
  const [scheme, token] = value.split(/\s+/u, 2);
  return scheme?.toLowerCase() === "bearer" ? token || "" : "";
};

const flattenErrorValues = function flattenErrorValues(error) {
  const values = [];
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    values.push(current);
    seen.add(current);
    current = current.cause;
  }
  return values;
};

const parseHTTPStatus = function parseHTTPStatus(value) {
  if (Number.isInteger(value) && value >= 100 && value <= 599) {
    return value;
  }
  if (isStringValue(value) && /^\d{3}$/u.test(value.trim())) {
    const parsed = Math.trunc(Number(value));
    if (parsed >= 100 && parsed <= 599) {
      return parsed;
    }
  }
  return 0;
};

const isAuthenticationSDKError = function isAuthenticationSDKError(error) {
  return flattenErrorValues(error).some((value) => {
    const name = String(value?.name || "").toLowerCase();
    const code = String(value?.code || "").toLowerCase();
    const message = String(
      value?.message || value?.rawMessage || ""
    ).toLowerCase();
    const status = parseHTTPStatus(value?.status);
    const authenticationMessages = [
      "missing or invalid authorization",
      "invalid authorization",
      "unauthorized",
    ];
    return (
      status === 401 ||
      name.includes("authentication") ||
      ["unauthorized", "authentication_error"].includes(code) ||
      authenticationMessages.some((part) => message.includes(part))
    );
  });
};

const isRetryableSDKRunError = function isRetryableSDKRunError(error) {
  const values = flattenErrorValues(error);
  if (values.some((value) => value?.isRetryable === true)) {
    return true;
  }
  if (
    values.some(
      (value) =>
        value?.status === 429 ||
        value?.status === 503 ||
        value?.code === 8 ||
        value?.code === 14
    )
  ) {
    return true;
  }
  const retryableMessages = [
    "server at capacity",
    "temporarily unavailable",
    "resource exhausted",
    "rate limit",
    "too many requests",
    "try again",
  ];
  return values.some((value) => {
    const text = [
      value?.message,
      value?.rawMessage,
      value?.code,
      value?.status,
      value?.name,
    ]
      .filter((item) => item !== undefined && item !== null)
      .map((item) => String(item).toLowerCase());
    return text.some(
      (item) =>
        retryableMessages.some((part) => item.includes(part)) ||
        ["unavailable", "resource_exhausted"].includes(item)
    );
  });
};

const statusFromError = function statusFromError(error) {
  for (const value of flattenErrorValues(error)) {
    const status = parseHTTPStatus(value?.status);
    if (status) {
      return status;
    }
  }
  if (isAuthenticationSDKError(error)) {
    return 401;
  }
  if (isRetryableSDKRunError(error)) {
    return 503;
  }
  return 500;
};

const firstNonEmptyString = function firstNonEmptyString(...values) {
  for (const value of values) {
    if (isStringValue(value) && value.trim()) {
      return value.trim();
    }
  }
  return "";
};

const messageFromError = function messageFromError(error, status) {
  if (status === 401 && isAuthenticationSDKError(error)) {
    return "Missing or invalid authorization";
  }
  const message = firstNonEmptyString(
    error?.message,
    error?.rawMessage,
    error?.error,
    error?.details
  );
  if (message && message !== "Error") {
    return message;
  }
  if (status === 401) {
    return "Missing or invalid authorization";
  }
  return message || "Cursor SDK request failed";
};

const codeFromError = function codeFromError(error, status) {
  if (status === 401 && isAuthenticationSDKError(error)) {
    return "unauthorized";
  }
  const code = firstNonEmptyString(error?.code, error?.cause?.code);
  if (code && !(status === 401 && code === "internal")) {
    return code;
  }
  if (status === 401) {
    return "unauthorized";
  }
  if (status === 503) {
    return "cursor_sdk_unavailable";
  }
  return code || "cursor_sdk_error";
};

const openAiError = function openAiError(error) {
  const status = statusFromError(error);
  const message = messageFromError(error, status);
  const code = codeFromError(error, status);
  return {
    error: {
      code,
      message,
      status,
      type:
        error?.type || (status >= 500 ? "api_error" : "invalid_request_error"),
    },
  };
};

const readJsonBody = async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxJsonBytes) {
      throw new HttpError("Request body too large", 413, "request_too_large");
    }
  }
  if (!body.trim()) {
    return {};
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError("Invalid JSON", 400, "invalid_json");
  }
};

const requiredString = function requiredString(value, key) {
  if (!isStringValue(value) || !value.trim()) {
    throw new HttpError(`Missing ${key}`, 400, "invalid_request");
  }
  return value;
};

const isRecord = function isRecord(value) {
  return (
    Boolean(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
};

const captureActiveClientToolCall = async function captureActiveClientToolCall(
  cacheKey,
  toolCall
) {
  const handlers = activeClientToolCaptures.get(cacheKey);
  if (!handlers || handlers.size === 0) {
    return false;
  }
  const tryHandlers = async function tryHandlers(handlerIterator) {
    const next = handlerIterator.next();
    if (next.done) {
      return false;
    }
    if (await next.value(toolCall)) {
      return true;
    }
    return tryHandlers(handlerIterator);
  };
  return await tryHandlers(handlers[Symbol.iterator]());
};

const handleClientToolCallback = async function handleClientToolCallback(
  request,
  response
) {
  if (bridgeToken && bearerToken(request) !== bridgeToken) {
    writeJson(
      response,
      openAiError(new HttpError("Invalid bridge token", 401, "unauthorized")),
      401
    );
    return;
  }
  const body = await readJsonBody(request);
  const cacheKey = requiredString(body.cacheKey, "cacheKey");
  const toolName = requiredString(body.toolName, "toolName");
  const args = isRecord(body.arguments) ? body.arguments : {};
  const accepted = await captureActiveClientToolCall(cacheKey, {
    args,
    type: toolName,
  });
  writeJson(response, { accepted, ok: true });
};

const normalizeModel = function normalizeModel(model) {
  const fastComposerModel = `${composerModel}-fast`;
  const raw = model.trim();
  const segments = raw.toLowerCase().split("/").filter(Boolean);
  const normalized = segments.length ? segments.at(-1) : "";
  if (!normalized || normalized === "default" || normalized === "auto") {
    return "default";
  }
  if (
    normalized === "composer-latest" ||
    normalized === "composer" ||
    normalized === "composer-2.5" ||
    normalized === "composer-2-5"
  ) {
    return composerModel;
  }
  if (normalized === "composer-2.5-sdk" || normalized === "composer-2-5-sdk") {
    return composerModel;
  }
  if (
    normalized === "composer-2.5-fast" ||
    normalized === "composer-2-5-fast"
  ) {
    return fastComposerModel;
  }
  return raw;
};

const sdkWorkingDirectory = function sdkWorkingDirectory(value) {
  const trimmed = isStringValue(value) ? value.trim() : "";
  if (
    !trimmed ||
    trimmed.toLowerCase() === "undefined" ||
    trimmed.toLowerCase() === "null"
  ) {
    return defaultCwd;
  }
  return trimmed;
};

const isJsonPrimitive = function isJsonPrimitive(value) {
  return isStringValue(value) || isNumberValue(value) || isBooleanValue(value);
};

const isJsonSerializable = function isJsonSerializable(value) {
  return (
    value === null ||
    isJsonPrimitive(value) ||
    Array.isArray(value) ||
    isRecord(value)
  );
};

const normalizeArguments = function normalizeArguments(args) {
  const output = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || isFunctionValue(value) || isSymbolValue(value)) {
      continue;
    }
    output[key] = normalizeJsonValue(value);
  }
  return output;
};

normalizeJsonValue = (value) => {
  if (value === null || isJsonPrimitive(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (isRecord(value)) {
    return normalizeArguments(value);
  }
  return String(value);
};

const parseClientTools = function parseClientTools(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((tool) => {
    if (!isRecord(tool) || !isStringValue(tool.name) || !tool.name.trim()) {
      return [];
    }
    const description = isStringValue(tool.description)
      ? tool.description
      : undefined;
    const parameters = isJsonSerializable(tool.parameters)
      ? tool.parameters
      : undefined;
    const normalized = { name: tool.name.trim() };
    if (description) {
      normalized.description = description;
    }
    if (parameters !== undefined) {
      normalized.parameters = normalizeJsonValue(parameters);
    }
    return [normalized];
  });
};

const clientToolsNeedingMcp = function clientToolsNeedingMcp(clientTools = []) {
  return clientTools.filter((tool) => tool?.name);
};

const bridgePrompt = function bridgePrompt(prompt, clientTools = []) {
  const mcpClientTools = clientToolsNeedingMcp(clientTools);
  const exactToolNames = [];
  for (const tool of clientTools) {
    if (isStringValue(tool?.name) && tool.name.trim()) {
      exactToolNames.push(tool.name);
    }
  }
  const exactMcpToolNames = [];
  for (const tool of mcpClientTools) {
    if (isStringValue(tool?.name) && tool.name.trim()) {
      exactMcpToolNames.push(tool.name);
    }
  }
  const exactTools = exactToolNames.join(", ");
  const exactMcpTools = exactMcpToolNames.join(", ");
  const toolInstruction = exactTools
    ? `The outer client tools are: ${exactTools}.`
    : "No outer client tools were provided for this request.";
  const mcpInstruction = exactMcpTools
    ? `Client-only tools are exposed through the client MCP server by exact name: ${exactMcpTools}.`
    : "No client MCP forwarding tools are attached for this turn; answer without new local tool calls unless the prompt contains LOCAL TOOL RESULT records to continue from.";
  const localServerInstruction = exactMcpTools
    ? "A local MCP server named client exposes forwarding tools such as client_shell, client_write, client_read, client_edit, client_delete, client_glob, client_grep, and the exact outer client tool names."
    : "No local MCP server tools are available on this turn.";
  return [
    "You are running through the real Cursor SDK local runtime behind an OpenAI-compatible client.",
    "The outer client owns local tool execution. The bridge must forward local operations; it must not execute SDK built-in shell/read/write/edit/glob/grep/ls/delete tools inside the bridge runtime.",
    toolInstruction,
    mcpInstruction,
    localServerInstruction,
    "Prefer exact client tools and dedicated client MCP tools such as write, read, edit, glob, grep, ls, delete, client_write, client_read, client_edit, client_glob, client_grep, client_ls, and client_delete before bash/client_shell. Use shell only for commands or when no dedicated client tool fits.",
    'Use SDK mcp with providerIdentifier "client" for every local operation. Do not use SDK built-in shell, write, edit, read, glob, grep, ls, delete, readLints, semSearch, todowrite, task, createPlan, generateImage, or recordScreen.',
    "If the prompt says LOCAL TOOL REQUIRED, emit exactly one client MCP forwarding tool call and no prose.",
    "If LOCAL TOOL RESULT records are present, treat those tools as already executed by the outer client and continue from the result.",
    "",
    prompt,
  ].join("\n");
};

const writeNdjson = function writeNdjson(response, body) {
  if (response.writableEnded || response.destroyed) {
    return false;
  }
  try {
    response.write(`${JSON.stringify(body)}\n`);
    return true;
  } catch (error) {
    if (error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED") {
      return false;
    }
    throw error;
  }
};

const agentCacheKey = function agentCacheKey(input) {
  const digest = crypto
    .createHash("sha256")
    .update(
      [
        input.apiKey,
        input.model,
        input.workingDirectory,
        input.sessionKey,
      ].join("\0")
    )
    .digest("hex")
    .slice(0, 32);
  return digest;
};

const runExclusiveForAgent = function runExclusiveForAgent(input, work) {
  const cacheKey = agentCacheKey(input);
  const previous = agentRunQueues.get(cacheKey) ?? Promise.resolve();
  const current = (async () => {
    try {
      await previous;
    } catch {
      ignoreError();
    }
    return work();
  })();
  agentRunQueues.set(
    cacheKey,
    (async () => {
      try {
        await current;
      } catch {
        ignoreError();
      }
    })()
  );
  return current;
};

const parseJsonObject = function parseJsonObject(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const canonicalToolName = function canonicalToolName(name) {
  return String(name || "")
    .replaceAll(/[^A-Za-z0-9]/gu, "")
    .toLowerCase();
};

const normalizeToolName = function normalizeToolName(name) {
  return canonicalToolName(name);
};

const objectArgumentFrom = function objectArgumentFrom(source, ...keys) {
  if (!isRecord(source)) {
    return {};
  }
  for (const key of keys) {
    const value = source[key];
    if (isRecord(value)) {
      return value;
    }
    if (isStringValue(value)) {
      const parsed = parseJsonObject(value);
      if (parsed) {
        return parsed;
      }
    }
  }
  const normalizedKeys = new Set(keys.map(normalizeToolName));
  for (const [key, value] of Object.entries(source)) {
    if (!normalizedKeys.has(normalizeToolName(key))) {
      continue;
    }
    if (isRecord(value)) {
      return value;
    }
    if (isStringValue(value)) {
      const parsed = parseJsonObject(value);
      if (parsed) {
        return parsed;
      }
    }
  }
  return {};
};

const firstString = function firstString(args, ...keys) {
  for (const key of keys) {
    if (isStringValue(args[key]) && args[key].trim()) {
      return args[key].trim();
    }
  }
  return "";
};

const CLIENT_MCP_SDK_TOOL_NAMES = new Map([
  ["shell", "shell"],
  ["bash", "shell"],
  ["run", "shell"],
  ["runcommand", "shell"],
  ["write", "write"],
  ["writefile", "write"],
  ["read", "read"],
  ["readfile", "read"],
  ["edit", "edit"],
  ["editfile", "edit"],
  ["delete", "delete"],
  ["deletefile", "delete"],
  ["remove", "delete"],
  ["removefile", "delete"],
  ["glob", "glob"],
  ["fileglob", "glob"],
  ["grep", "grep"],
  ["search", "grep"],
  ["ls", "ls"],
  ["list", "ls"],
  ["listfiles", "ls"],
  ["readlints", "readLints"],
  ["diagnostics", "readLints"],
  ["semsearch", "semSearch"],
  ["semanticsearch", "semSearch"],
  ["todowrite", "todowrite"],
  ["todos", "todowrite"],
  ["updatetodos", "todowrite"],
  ["task", "task"],
  ["subagent", "task"],
  ["subagenttask", "task"],
  ["createplan", "createPlan"],
  ["generateimage", "generateImage"],
  ["imagegeneration", "generateImage"],
  ["imagegen", "generateImage"],
  ["recordscreen", "recordScreen"],
  ["screenrecord", "recordScreen"],
  ["screenrecording", "recordScreen"],
]);

const sdkToolNameFromClientMcpTool = function sdkToolNameFromClientMcpTool(
  toolName
) {
  const normalized = normalizeToolName(toolName).replace(/^client/u, "");
  return CLIENT_MCP_SDK_TOOL_NAMES.get(normalized) ?? null;
};

const objectArgumentEntryFrom = function objectArgumentEntryFrom(
  source,
  ...keys
) {
  if (!isRecord(source)) {
    return null;
  }
  for (const key of keys) {
    const value = source[key];
    if (isRecord(value)) {
      return { key, value };
    }
    if (isStringValue(value)) {
      const parsed = parseJsonObject(value);
      if (parsed) {
        return { key, value: parsed };
      }
    }
  }
  const normalizedKeys = new Set(keys.map(normalizeToolName));
  for (const [key, value] of Object.entries(source)) {
    if (!normalizedKeys.has(normalizeToolName(key))) {
      continue;
    }
    if (isRecord(value)) {
      return { key, value };
    }
    if (isStringValue(value)) {
      const parsed = parseJsonObject(value);
      if (parsed) {
        return { key, value: parsed };
      }
    }
  }
  return null;
};

const firstMatchingKey = function firstMatchingKey(source, ...keys) {
  if (!isRecord(source)) {
    return "";
  }
  for (const key of keys) {
    if (Object.hasOwn(source, key)) {
      return key;
    }
  }
  const normalizedKeys = new Set(keys.map(normalizeToolName));
  for (const key of Object.keys(source)) {
    if (normalizedKeys.has(normalizeToolName(key))) {
      return key;
    }
  }
  return "";
};

const clientMcpPayloadArguments = function clientMcpPayloadArguments(args) {
  const envelope = objectArgumentEntryFrom(
    args,
    "args",
    "arguments",
    "input",
    "parameters",
    "params",
    "payload",
    "data"
  );
  if (envelope && Object.keys(envelope.value).length > 0) {
    return envelope.value;
  }
  if (!isRecord(args)) {
    return {};
  }
  const providerKey = firstMatchingKey(
    args,
    "providerIdentifier",
    "provider",
    "server",
    "serverName",
    "server_name"
  );
  const toolKey = firstMatchingKey(
    args,
    "toolName",
    "tool_name",
    "tool",
    "name"
  );
  const output = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === providerKey || key === toolKey || key === envelope?.key) {
      continue;
    }
    output[key] = value;
  }
  return output;
};

const normalizeClientMcpToolCall = function normalizeClientMcpToolCall(
  name,
  args
) {
  if (canonicalToolName(name) !== "mcp") {
    return null;
  }
  const provider = firstString(
    args,
    "providerIdentifier",
    "provider",
    "server",
    "serverName",
    "server_name"
  );
  if (provider && provider !== clientMcpServerName) {
    return null;
  }
  const toolName = firstString(args, "toolName", "tool_name", "tool", "name");
  const sdkName = sdkToolNameFromClientMcpTool(toolName);
  const payload = clientMcpPayloadArguments(args);
  if (!sdkName) {
    return {
      arguments: {
        args: normalizeArguments(payload),
        providerIdentifier: clientMcpServerName,
        toolName,
      },
      name: "mcp",
    };
  }
  return {
    arguments: normalizeArguments(payload),
    name: sdkName,
  };
};

const normalizeDirectClientToolCall = function normalizeDirectClientToolCall(
  name,
  args,
  clientTools = []
) {
  const sdkName = sdkToolNameFromClientMcpTool(name);
  const normalizedName = normalizeToolName(name);
  const matchingClientTool = clientTools.find(
    (tool) => normalizeToolName(tool.name) === normalizedName
  );
  if (sdkName && (normalizedName.startsWith("client") || matchingClientTool)) {
    return {
      arguments: normalizeArguments(args),
      name: sdkName,
    };
  }
  if (!matchingClientTool) {
    return null;
  }
  return {
    arguments: {
      args: normalizeArguments(args),
      providerIdentifier: clientMcpServerName,
      toolName: matchingClientTool.name,
    },
    name: "mcp",
  };
};

const sdkToolCallName = function sdkToolCallName(toolCall) {
  if (isStringValue(toolCall.type)) {
    return toolCall.type;
  }
  if (isStringValue(toolCall.name)) {
    return toolCall.name;
  }
  return "";
};

const normalizeSDKToolCall = function normalizeSDKToolCall(
  toolCall,
  clientTools = []
) {
  const name = sdkToolCallName(toolCall);
  if (!name) {
    return null;
  }
  const args = objectArgumentFrom(
    toolCall,
    "args",
    "arguments",
    "input",
    "parameters",
    "params"
  );
  const clientMcpTool = normalizeClientMcpToolCall(name, args);
  if (clientMcpTool) {
    return clientMcpTool;
  }
  const directClientTool = normalizeDirectClientToolCall(
    name,
    args,
    clientTools
  );
  if (directClientTool) {
    return directClientTool;
  }
  return {
    arguments: normalizeArguments(args),
    name,
  };
};

const matchingClientToolByName = function matchingClientToolByName(
  toolName,
  clientTools = []
) {
  const normalized = normalizeToolName(toolName);
  return (
    clientTools.find((tool) => normalizeToolName(tool?.name) === normalized) ||
    null
  );
};

const schemaHasStructuralKeyword = function schemaHasStructuralKeyword(schema) {
  return [
    "$defs",
    "$ref",
    "additionalProperties",
    "additionalItems",
    "allOf",
    "anyOf",
    "const",
    "contains",
    "definitions",
    "else",
    "enum",
    "if",
    "items",
    "maxContains",
    "maxItems",
    "maxProperties",
    "minContains",
    "minItems",
    "minProperties",
    "not",
    "oneOf",
    "patternProperties",
    "prefixItems",
    "properties",
    "propertyNames",
    "required",
    "then",
    "dependentRequired",
    "dependentSchemas",
    "type",
    "unevaluatedItems",
    "unevaluatedProperties",
    "uniqueItems",
  ].some((key) => Object.hasOwn(schema, key));
};

const canonicalJsonSchema = function canonicalJsonSchema(schema) {
  let current = schema;
  const visited = new Set();
  while (isRecord(current)) {
    if (schemaHasStructuralKeyword(current)) {
      return current;
    }
    if (visited.has(current)) {
      return current;
    }
    visited.add(current);
    let wrapped = null;
    for (const key of [
      "schema",
      "json_schema",
      "input_schema",
      "inputSchema",
    ]) {
      const candidate = current[key];
      if (isRecord(candidate)) {
        wrapped = candidate;
        break;
      }
    }
    if (!wrapped) {
      return current;
    }
    current = wrapped;
  }
  return current;
};

const clientMcpInputSchema = function clientMcpInputSchema(parameters) {
  if (isRecord(parameters) && Object.keys(parameters).length > 0) {
    return canonicalJsonSchema(normalizeJsonValue(parameters));
  }
  return {
    additionalProperties: true,
    type: "object",
  };
};

const decodeJsonPointerSegment = function decodeJsonPointerSegment(segment) {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
};

const jsonPointerTarget = function jsonPointerTarget(root, ref) {
  if (ref === "#") {
    return root;
  }
  if (!ref.startsWith("#/")) {
    return null;
  }
  let pointer = ref.slice(1);
  try {
    pointer = decodeURIComponent(pointer);
  } catch {
    void 0;
  }
  let target = root;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = decodeJsonPointerSegment(rawSegment);
    if (Array.isArray(target) && /^\d+$/u.test(segment)) {
      target = target[Number(segment)];
    } else if (isRecord(target) && Object.hasOwn(target, segment)) {
      target = target[segment];
    } else {
      return null;
    }
  }
  return target;
};

const schemaReferenceTarget = function schemaReferenceTarget(
  schema,
  rootSchema,
  seenRefs = new Set()
) {
  if (!isRecord(schema) || !isStringValue(schema.$ref)) {
    return null;
  }
  const ref = schema.$ref.trim();
  if (!ref.startsWith("#") || seenRefs.has(ref)) {
    return null;
  }
  const target = jsonPointerTarget(rootSchema, ref);
  if (!isRecord(target)) {
    return null;
  }
  const nextSeenRefs = new Set([...seenRefs, ref]);
  return { schema: target, seenRefs: nextSeenRefs };
};

const sortJson = function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, sortJson(value[key])])
  );
};

const stableJson = function stableJson(value) {
  return JSON.stringify(sortJson(value));
};

const jsonValuesEqual = function jsonValuesEqual(left, right) {
  if (Object.is(left, right)) {
    return true;
  }
  return stableJson(left) === stableJson(right);
};

const schemaTypes = function schemaTypes(schema) {
  if (isStringValue(schema.type)) {
    return [schema.type];
  }
  if (Array.isArray(schema.type)) {
    return schema.type.filter(isStringValue);
  }
  return [];
};

const schemaAllowsNull = function schemaAllowsNull(
  schema,
  rootSchema = schema,
  seenRefs = new Set()
) {
  const resolvedSchema = canonicalJsonSchema(schema);
  if (!isRecord(resolvedSchema)) {
    return false;
  }
  const root = canonicalJsonSchema(rootSchema || resolvedSchema);
  const reference = schemaReferenceTarget(resolvedSchema, root, seenRefs);
  if (reference) {
    return schemaAllowsNull(reference.schema, root, reference.seenRefs);
  }
  if (resolvedSchema?.nullable === true) {
    return true;
  }
  if (schemaTypes(resolvedSchema).includes("null")) {
    return true;
  }
  for (const key of ["anyOf", "oneOf"]) {
    const variants = Array.isArray(resolvedSchema[key])
      ? resolvedSchema[key]
      : [];
    if (
      variants.some(
        (candidate) =>
          candidate &&
          isRecord(candidate) &&
          schemaAllowsNull(candidate, root, new Set(seenRefs))
      )
    ) {
      return true;
    }
  }
  return false;
};

const jsonValueMatchesType = function jsonValueMatchesType(value, type) {
  switch (type) {
    case "string": {
      return isStringValue(value);
    }
    case "number": {
      return isNumberValue(value) && Number.isFinite(value);
    }
    case "integer": {
      return Number.isInteger(value);
    }
    case "boolean": {
      return isBooleanValue(value);
    }
    case "array": {
      return Array.isArray(value);
    }
    case "object": {
      return isRecord(value);
    }
    case "null": {
      return value === null;
    }
    default: {
      return true;
    }
  }
};

const validateStringConstraints = function validateStringConstraints(
  value,
  schema,
  valuePath
) {
  if (!isStringValue(value)) {
    return null;
  }
  const { length } = [...value];
  if (Number.isInteger(schema.minLength) && length < schema.minLength) {
    return `Invalid value for ${valuePath}: expected at least ${schema.minLength} character(s)`;
  }
  if (Number.isInteger(schema.maxLength) && length > schema.maxLength) {
    return `Invalid value for ${valuePath}: expected at most ${schema.maxLength} character(s)`;
  }
  if (isStringValue(schema.pattern) && schema.pattern) {
    try {
      if (!new RegExp(schema.pattern, "u").test(value)) {
        return `Invalid value for ${valuePath}: expected to match pattern ${schema.pattern}`;
      }
    } catch {
      void 0;
    }
  }
  return null;
};

const validateNumberConstraints = function validateNumberConstraints(
  value,
  schema,
  valuePath
) {
  if (!isNumberValue(value) || !Number.isFinite(value)) {
    return null;
  }
  if (isNumberValue(schema.minimum) && value < schema.minimum) {
    return `Invalid value for ${valuePath}: expected >= ${schema.minimum}`;
  }
  if (isNumberValue(schema.maximum) && value > schema.maximum) {
    return `Invalid value for ${valuePath}: expected <= ${schema.maximum}`;
  }
  if (
    isNumberValue(schema.exclusiveMinimum) &&
    value <= schema.exclusiveMinimum
  ) {
    return `Invalid value for ${valuePath}: expected > ${schema.exclusiveMinimum}`;
  }
  if (
    schema.exclusiveMinimum === true &&
    isNumberValue(schema.minimum) &&
    value <= schema.minimum
  ) {
    return `Invalid value for ${valuePath}: expected > ${schema.minimum}`;
  }
  if (
    isNumberValue(schema.exclusiveMaximum) &&
    value >= schema.exclusiveMaximum
  ) {
    return `Invalid value for ${valuePath}: expected < ${schema.exclusiveMaximum}`;
  }
  if (
    schema.exclusiveMaximum === true &&
    isNumberValue(schema.maximum) &&
    value >= schema.maximum
  ) {
    return `Invalid value for ${valuePath}: expected < ${schema.maximum}`;
  }
  if (isNumberValue(schema.multipleOf) && schema.multipleOf > 0) {
    const quotient = value / schema.multipleOf;
    if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 100) {
      return `Invalid value for ${valuePath}: expected a multiple of ${schema.multipleOf}`;
    }
  }
  return null;
};

const patternPropertySchemasForKey = function patternPropertySchemasForKey(
  schema,
  key
) {
  if (!isRecord(schema.patternProperties)) {
    return [];
  }
  const output = [];
  for (const [pattern, patternSchema] of Object.entries(
    schema.patternProperties
  )) {
    if (!isRecord(patternSchema) && !isBooleanValue(patternSchema)) {
      continue;
    }
    try {
      if (new RegExp(pattern, "u").test(key)) {
        output.push(patternSchema);
      }
    } catch {
      void 0;
    }
  }
  return output;
};

const schemaEvaluatesFromDependentSchemas =
  function schemaEvaluatesFromDependentSchemas(
    schema,
    key,
    rootSchema,
    value,
    seenRefs
  ) {
    if (!isRecord(schema.dependentSchemas) || !isRecord(value)) {
      return false;
    }
    for (const [dependency, dependentSchema] of Object.entries(
      schema.dependentSchemas
    )) {
      if (!Object.hasOwn(value, dependency)) {
        continue;
      }
      if (
        schemaEvaluatesObjectProperty(
          dependentSchema,
          key,
          rootSchema,
          value,
          new Set(seenRefs)
        )
      ) {
        return true;
      }
    }
    return false;
  };

const schemaEvaluatesFromUnionSchemas =
  function schemaEvaluatesFromUnionSchemas(
    schema,
    key,
    rootSchema,
    value,
    seenRefs
  ) {
    for (const keyword of ["anyOf", "oneOf"]) {
      if (!Array.isArray(schema[keyword])) {
        continue;
      }
      for (const candidate of schema[keyword]) {
        if (
          validateJsonSchemaValue(
            value,
            candidate,
            "$",
            rootSchema,
            new Set(seenRefs)
          ) !== null
        ) {
          continue;
        }
        if (
          schemaEvaluatesObjectProperty(
            candidate,
            key,
            rootSchema,
            value,
            new Set(seenRefs)
          )
        ) {
          return true;
        }
      }
    }
    return false;
  };

const schemaEvaluatesFromConditionalSchema =
  function schemaEvaluatesFromConditionalSchema(
    schema,
    key,
    rootSchema,
    value,
    seenRefs
  ) {
    if (!isRecord(schema.if) && !isBooleanValue(schema.if)) {
      return false;
    }
    const matchesIf =
      validateJsonSchemaValue(
        value,
        schema.if,
        "$",
        rootSchema,
        new Set(seenRefs)
      ) === null;
    if (
      matchesIf &&
      schemaEvaluatesObjectProperty(
        schema.if,
        key,
        rootSchema,
        value,
        new Set(seenRefs)
      )
    ) {
      return true;
    }
    const branch = matchesIf ? schema["then"] : schema.else;
    return (
      (isRecord(branch) || isBooleanValue(branch)) &&
      schemaEvaluatesObjectProperty(
        branch,
        key,
        rootSchema,
        value,
        new Set(seenRefs)
      )
    );
  };

schemaEvaluatesObjectProperty = (
  schema,
  key,
  rootSchema,
  value,
  seenRefs = new Set()
) => {
  const resolvedSchema = canonicalJsonSchema(schema);
  if (
    !resolvedSchema ||
    !isRecord(resolvedSchema) ||
    Array.isArray(resolvedSchema)
  ) {
    return false;
  }
  const reference = schemaReferenceTarget(resolvedSchema, rootSchema, seenRefs);
  if (reference) {
    return schemaEvaluatesObjectProperty(
      reference.schema,
      key,
      rootSchema,
      value,
      reference.seenRefs
    );
  }
  if (
    isRecord(resolvedSchema.properties) &&
    Object.hasOwn(resolvedSchema.properties, key)
  ) {
    return true;
  }
  if (patternPropertySchemasForKey(resolvedSchema, key).length > 0) {
    return true;
  }
  if (
    resolvedSchema.additionalProperties === true ||
    isRecord(resolvedSchema.additionalProperties)
  ) {
    return true;
  }
  if (
    schemaEvaluatesFromDependentSchemas(
      resolvedSchema,
      key,
      rootSchema,
      value,
      seenRefs
    )
  ) {
    return true;
  }
  if (
    Array.isArray(resolvedSchema.allOf) &&
    resolvedSchema.allOf.some((candidate) =>
      schemaEvaluatesObjectProperty(
        candidate,
        key,
        rootSchema,
        value,
        new Set(seenRefs)
      )
    )
  ) {
    return true;
  }
  if (
    schemaEvaluatesFromUnionSchemas(
      resolvedSchema,
      key,
      rootSchema,
      value,
      seenRefs
    )
  ) {
    return true;
  }
  return schemaEvaluatesFromConditionalSchema(
    resolvedSchema,
    key,
    rootSchema,
    value,
    seenRefs
  );
};

const validateJsonSchemaLiteralRules = function validateJsonSchemaLiteralRules(
  value,
  schema,
  valuePath
) {
  if (Object.hasOwn(schema, "const") && !jsonValuesEqual(value, schema.const)) {
    return `Invalid value for ${valuePath}: expected constant ${JSON.stringify(schema.const)}`;
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => jsonValuesEqual(candidate, value))
  ) {
    return `Invalid value for ${valuePath}: expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`;
  }
  return null;
};

const validateJsonSchemaAnyOfRule = function validateJsonSchemaAnyOfRule(
  value,
  schema,
  valuePath,
  root,
  seenRefs
) {
  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  if (
    anyOf.length &&
    !anyOf.some(
      (candidate) =>
        validateJsonSchemaValue(
          value,
          candidate,
          valuePath,
          root,
          new Set(seenRefs)
        ) === null
    )
  ) {
    return `Invalid value for ${valuePath}: did not match any allowed schema`;
  }
  return null;
};

const validateJsonSchemaOneOfRule = function validateJsonSchemaOneOfRule(
  value,
  schema,
  valuePath,
  root,
  seenRefs
) {
  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  if (!oneOf.length) {
    return null;
  }
  const matches = oneOf.filter(
    (candidate) =>
      validateJsonSchemaValue(
        value,
        candidate,
        valuePath,
        root,
        new Set(seenRefs)
      ) === null
  ).length;
  if (matches === 0) {
    return `Invalid value for ${valuePath}: did not match any allowed schema`;
  }
  if (matches > 1) {
    return `Invalid value for ${valuePath}: matched more than one allowed schema`;
  }
  return null;
};

const validateJsonSchemaAllOfRule = function validateJsonSchemaAllOfRule(
  value,
  schema,
  valuePath,
  root,
  seenRefs
) {
  const allOf = Array.isArray(schema.allOf) ? schema.allOf : [];
  for (const candidate of allOf) {
    const error = validateJsonSchemaValue(
      value,
      candidate,
      valuePath,
      root,
      new Set(seenRefs)
    );
    if (error) {
      return error;
    }
  }
  return null;
};

const validateJsonSchemaNotRule = function validateJsonSchemaNotRule(
  value,
  schema,
  valuePath,
  root,
  seenRefs
) {
  if (
    (isRecord(schema.not) || isBooleanValue(schema.not)) &&
    validateJsonSchemaValue(
      value,
      schema.not,
      valuePath,
      root,
      new Set(seenRefs)
    ) === null
  ) {
    return `Invalid value for ${valuePath}: matched disallowed schema`;
  }
  return null;
};

const validateJsonSchemaIfRule = function validateJsonSchemaIfRule(
  value,
  schema,
  valuePath,
  root,
  seenRefs
) {
  if (!isRecord(schema.if) && !isBooleanValue(schema.if)) {
    return null;
  }
  const matchesIf =
    validateJsonSchemaValue(
      value,
      schema.if,
      valuePath,
      root,
      new Set(seenRefs)
    ) === null;
  const branch = matchesIf ? schema["then"] : schema.else;
  if (!isRecord(branch) && !isBooleanValue(branch)) {
    return null;
  }
  if (!matchesIf && !schema.else) {
    return null;
  }
  return validateJsonSchemaValue(
    value,
    branch,
    valuePath,
    root,
    new Set(seenRefs)
  );
};

const validateJsonSchemaComposition = function validateJsonSchemaComposition(
  value,
  schema,
  valuePath,
  root,
  seenRefs
) {
  const literalError = validateJsonSchemaLiteralRules(value, schema, valuePath);
  if (literalError) {
    return literalError;
  }
  const anyOfError = validateJsonSchemaAnyOfRule(
    value,
    schema,
    valuePath,
    root,
    seenRefs
  );
  if (anyOfError) {
    return anyOfError;
  }
  const oneOfError = validateJsonSchemaOneOfRule(
    value,
    schema,
    valuePath,
    root,
    seenRefs
  );
  if (oneOfError) {
    return oneOfError;
  }
  const allOfError = validateJsonSchemaAllOfRule(
    value,
    schema,
    valuePath,
    root,
    seenRefs
  );
  if (allOfError) {
    return allOfError;
  }
  const notError = validateJsonSchemaNotRule(
    value,
    schema,
    valuePath,
    root,
    seenRefs
  );
  if (notError) {
    return notError;
  }
  return validateJsonSchemaIfRule(value, schema, valuePath, root, seenRefs);
};

const validateJsonSchemaObjectEntryNames =
  function validateJsonSchemaObjectEntryNames(
    key,
    schema,
    valuePath,
    root,
    seenRefs
  ) {
    if (
      !isRecord(schema.propertyNames) &&
      !isBooleanValue(schema.propertyNames)
    ) {
      return null;
    }
    return validateJsonSchemaValue(
      key,
      schema.propertyNames,
      `${valuePath} property name ${key}`,
      root,
      new Set(seenRefs)
    );
  };

const validateJsonSchemaObjectEntryExtras =
  function validateJsonSchemaObjectEntryExtras(
    key,
    nestedValue,
    schema,
    validated,
    evaluatedByComposedSchema,
    valuePath,
    root,
    seenRefs
  ) {
    if (
      !validated &&
      !evaluatedByComposedSchema &&
      schema.additionalProperties === false
    ) {
      return `Unexpected argument for ${valuePath}: ${key}`;
    }
    if (!validated && schema.additionalProperties === true) {
      return null;
    }
    if (!validated && isRecord(schema.additionalProperties)) {
      const error = validateJsonSchemaValue(
        nestedValue,
        schema.additionalProperties,
        `${valuePath}.${key}`,
        root,
        new Set(seenRefs)
      );
      if (error) {
        return error;
      }
      return null;
    }
    if (
      !validated &&
      !evaluatedByComposedSchema &&
      schema.unevaluatedProperties === false
    ) {
      return `Unexpected argument for ${valuePath}: ${key}`;
    }
    if (
      !validated &&
      !evaluatedByComposedSchema &&
      isRecord(schema.unevaluatedProperties)
    ) {
      return validateJsonSchemaValue(
        nestedValue,
        schema.unevaluatedProperties,
        `${valuePath}.${key}`,
        root,
        new Set(seenRefs)
      );
    }
    return null;
  };

const validateJsonSchemaObjectEntry = function validateJsonSchemaObjectEntry(
  key,
  nestedValue,
  schema,
  properties,
  value,
  valuePath,
  root,
  seenRefs
) {
  const nameError = validateJsonSchemaObjectEntryNames(
    key,
    schema,
    valuePath,
    root,
    seenRefs
  );
  if (nameError) {
    return nameError;
  }
  let validated = false;
  if (Object.hasOwn(properties, key)) {
    const error = validateJsonSchemaValue(
      nestedValue,
      properties[key],
      `${valuePath}.${key}`,
      root,
      new Set(seenRefs)
    );
    if (error) {
      return error;
    }
    validated = true;
  }
  const patternSchemas = patternPropertySchemasForKey(schema, key);
  for (const patternSchema of patternSchemas) {
    const error = validateJsonSchemaValue(
      nestedValue,
      patternSchema,
      `${valuePath}.${key}`,
      root,
      new Set(seenRefs)
    );
    if (error) {
      return error;
    }
    validated = true;
  }
  return validateJsonSchemaObjectEntryExtras(
    key,
    nestedValue,
    schema,
    validated,
    schemaEvaluatesObjectProperty(schema, key, root, value, new Set(seenRefs)),
    valuePath,
    root,
    seenRefs
  );
};

const validateJsonSchemaRequiredProperties =
  function validateJsonSchemaRequiredProperties(value, schema, valuePath) {
    const entries = Object.entries(value);
    if (
      Number.isInteger(schema.minProperties) &&
      entries.length < schema.minProperties
    ) {
      return `Invalid value for ${valuePath}: expected at least ${schema.minProperties} propert${schema.minProperties === 1 ? "y" : "ies"}`;
    }
    if (
      Number.isInteger(schema.maxProperties) &&
      entries.length > schema.maxProperties
    ) {
      return `Invalid value for ${valuePath}: expected at most ${schema.maxProperties} propert${schema.maxProperties === 1 ? "y" : "ies"}`;
    }
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key) => isStringValue(key) && key.trim())
      : [];
    for (const key of required) {
      if (!(key in value) || value[key] === undefined || value[key] === null) {
        return `Missing required argument for ${valuePath}: ${key}`;
      }
    }
    return null;
  };

const validateJsonSchemaDependentRequired =
  function validateJsonSchemaDependentRequired(value, schema, valuePath) {
    if (!isRecord(schema.dependentRequired)) {
      return null;
    }
    for (const [key, dependencies] of Object.entries(
      schema.dependentRequired
    )) {
      if (!Object.hasOwn(value, key) || !Array.isArray(dependencies)) {
        continue;
      }
      for (const dependency of dependencies) {
        if (!isStringValue(dependency) || !dependency.trim()) {
          continue;
        }
        if (
          !(dependency in value) ||
          value[dependency] === undefined ||
          value[dependency] === null
        ) {
          return `Missing dependent argument for ${valuePath}: ${dependency}`;
        }
      }
    }
    return null;
  };

const validateJsonSchemaObjectDependencies =
  function validateJsonSchemaObjectDependencies(
    value,
    schema,
    valuePath,
    root,
    seenRefs
  ) {
    const dependentRequiredError = validateJsonSchemaDependentRequired(
      value,
      schema,
      valuePath
    );
    if (dependentRequiredError) {
      return dependentRequiredError;
    }
    if (!isRecord(schema.dependentSchemas)) {
      return null;
    }
    for (const [key, dependentSchema] of Object.entries(
      schema.dependentSchemas
    )) {
      if (!Object.hasOwn(value, key)) {
        continue;
      }
      const error = validateJsonSchemaValue(
        value,
        dependentSchema,
        valuePath,
        root,
        new Set(seenRefs)
      );
      if (error) {
        return error;
      }
    }
    return null;
  };

const validateJsonSchemaObjectValue = function validateJsonSchemaObjectValue(
  value,
  schema,
  valuePath,
  root,
  seenRefs,
  types
) {
  const objectKeywords = [
    "properties",
    "patternProperties",
    "propertyNames",
    "required",
    "dependentRequired",
    "dependentSchemas",
  ];
  const objectConstraints = [
    "minProperties",
    "maxProperties",
    "additionalProperties",
    "unevaluatedProperties",
  ];
  const objectLike =
    objectKeywords.some((keyword) => schema[keyword]) ||
    objectConstraints.some((keyword) => schema[keyword] !== undefined) ||
    types.includes("object");
  if (!objectLike) {
    return null;
  }
  if (!isRecord(value)) {
    return `Invalid value for ${valuePath}: expected object`;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const requiredPropertiesError = validateJsonSchemaRequiredProperties(
    value,
    schema,
    valuePath
  );
  if (requiredPropertiesError) {
    return requiredPropertiesError;
  }
  const dependencyError = validateJsonSchemaObjectDependencies(
    value,
    schema,
    valuePath,
    root,
    seenRefs
  );
  if (dependencyError) {
    return dependencyError;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    const error = validateJsonSchemaObjectEntry(
      key,
      nestedValue,
      schema,
      properties,
      value,
      valuePath,
      root,
      seenRefs
    );
    if (error) {
      return error;
    }
  }
  return null;
};

const prefixItemsForSchema = function prefixItemsForSchema(schema) {
  if (Array.isArray(schema.prefixItems)) {
    return schema.prefixItems;
  }
  if (Array.isArray(schema.items)) {
    return schema.items;
  }
  return [];
};

const validateJsonSchemaArrayContains =
  function validateJsonSchemaArrayContains(
    value,
    schema,
    valuePath,
    root,
    seenRefs,
    evaluatedItems
  ) {
    if (!isRecord(schema.contains) && !isBooleanValue(schema.contains)) {
      return null;
    }
    let matches = 0;
    for (let index = 0; index < value.length; index += 1) {
      if (
        validateJsonSchemaValue(
          value[index],
          schema.contains,
          valuePath,
          root,
          new Set(seenRefs)
        ) === null
      ) {
        matches += 1;
        evaluatedItems.add(index);
      }
    }
    const minContains = Number.isInteger(schema.minContains)
      ? schema.minContains
      : 1;
    const maxContains = Number.isInteger(schema.maxContains)
      ? schema.maxContains
      : null;
    if (matches < minContains) {
      return `Invalid value for ${valuePath}: expected at least ${minContains} matching item${minContains === 1 ? "" : "s"}`;
    }
    if (maxContains !== null && matches > maxContains) {
      return `Invalid value for ${valuePath}: expected at most ${maxContains} matching item${maxContains === 1 ? "" : "s"}`;
    }
    return null;
  };

const validateJsonSchemaArrayUnique = function validateJsonSchemaArrayUnique(
  value,
  valuePath
) {
  if (!Array.isArray(value)) {
    return null;
  }
  for (let left = 0; left < value.length; left += 1) {
    for (let right = left + 1; right < value.length; right += 1) {
      if (jsonValuesEqual(value[left], value[right])) {
        return `Invalid value for ${valuePath}: expected unique items`;
      }
    }
  }
  return null;
};

const validateJsonSchemaArrayPrefixItems =
  function validateJsonSchemaArrayPrefixItems(
    value,
    schema,
    valuePath,
    root,
    seenRefs,
    evaluatedItems
  ) {
    const prefixItems = prefixItemsForSchema(schema);
    for (
      let index = 0;
      index < Math.min(prefixItems.length, value.length);
      index += 1
    ) {
      const error = validateJsonSchemaValue(
        value[index],
        prefixItems[index],
        `${valuePath}[${index}]`,
        root,
        new Set(seenRefs)
      );
      if (error) {
        return error;
      }
      evaluatedItems.add(index);
    }
    return null;
  };

const validateJsonSchemaExtraArrayItems =
  function validateJsonSchemaExtraArrayItems(
    value,
    itemSchema,
    startIndex,
    valuePath,
    root,
    seenRefs,
    evaluatedItems
  ) {
    if (itemSchema === false && value.length > startIndex) {
      return `Unexpected array item for ${valuePath}: ${startIndex}`;
    }
    if (itemSchema === true) {
      for (let index = startIndex; index < value.length; index += 1) {
        evaluatedItems.add(index);
      }
      return null;
    }
    if (!isRecord(itemSchema)) {
      return null;
    }
    for (let index = startIndex; index < value.length; index += 1) {
      const error = validateJsonSchemaValue(
        value[index],
        itemSchema,
        `${valuePath}[${index}]`,
        root,
        new Set(seenRefs)
      );
      if (error) {
        return error;
      }
      evaluatedItems.add(index);
    }
    return null;
  };

const validateJsonSchemaArrayExtraItems =
  function validateJsonSchemaArrayExtraItems(
    value,
    schema,
    valuePath,
    root,
    seenRefs,
    evaluatedItems
  ) {
    const prefixItems = prefixItemsForSchema(schema);
    const additionalItemsError = validateJsonSchemaExtraArrayItems(
      value,
      schema.additionalItems,
      prefixItems.length,
      valuePath,
      root,
      seenRefs,
      evaluatedItems
    );
    if (additionalItemsError) {
      return additionalItemsError;
    }
    if (schema.additionalItems === true) {
      return null;
    }
    if (Array.isArray(schema.items)) {
      return null;
    }
    return validateJsonSchemaExtraArrayItems(
      value,
      schema.items,
      prefixItems.length,
      valuePath,
      root,
      seenRefs,
      evaluatedItems
    );
  };

const validateJsonSchemaArrayUnevaluatedItems =
  function validateJsonSchemaArrayUnevaluatedItems(
    value,
    schema,
    valuePath,
    root,
    seenRefs,
    evaluatedItems
  ) {
    if (schema.unevaluatedItems === false) {
      const unevaluatedIndex = value.findIndex(
        (_item, index) => !evaluatedItems.has(index)
      );
      if (unevaluatedIndex !== -1) {
        return `Unexpected array item for ${valuePath}: ${unevaluatedIndex}`;
      }
      return null;
    }
    if (!isRecord(schema.unevaluatedItems)) {
      return null;
    }
    for (let index = 0; index < value.length; index += 1) {
      if (evaluatedItems.has(index)) {
        continue;
      }
      const error = validateJsonSchemaValue(
        value[index],
        schema.unevaluatedItems,
        `${valuePath}[${index}]`,
        root,
        new Set(seenRefs)
      );
      if (error) {
        return error;
      }
    }
    return null;
  };

const schemaIsArrayLike = function schemaIsArrayLike(schema, types) {
  const arrayKeywords = ["items", "prefixItems"];
  const arrayConstraints = [
    "additionalItems",
    "contains",
    "minItems",
    "maxItems",
    "minContains",
    "maxContains",
    "unevaluatedItems",
    "uniqueItems",
  ];
  return (
    arrayKeywords.some((keyword) => schema[keyword]) ||
    arrayConstraints.some((keyword) => schema[keyword] !== undefined) ||
    types.includes("array")
  );
};

const validateJsonSchemaArrayBounds = function validateJsonSchemaArrayBounds(
  value,
  schema,
  valuePath
) {
  if (!Array.isArray(value)) {
    return `Invalid value for ${valuePath}: expected array`;
  }
  if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
    return `Invalid value for ${valuePath}: expected at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`;
  }
  if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
    return `Invalid value for ${valuePath}: expected at most ${schema.maxItems} item${schema.maxItems === 1 ? "" : "s"}`;
  }
  return null;
};

const validateJsonSchemaArrayValue = function validateJsonSchemaArrayValue(
  value,
  schema,
  valuePath,
  root,
  seenRefs,
  types
) {
  if (!schemaIsArrayLike(schema, types)) {
    return null;
  }
  const boundsError = validateJsonSchemaArrayBounds(value, schema, valuePath);
  if (boundsError) {
    return boundsError;
  }
  if (schema.uniqueItems === true) {
    const uniqueError = validateJsonSchemaArrayUnique(value, valuePath);
    if (uniqueError) {
      return uniqueError;
    }
  }
  const evaluatedItems = new Set();
  const containsError = validateJsonSchemaArrayContains(
    value,
    schema,
    valuePath,
    root,
    seenRefs,
    evaluatedItems
  );
  if (containsError) {
    return containsError;
  }
  const prefixError = validateJsonSchemaArrayPrefixItems(
    value,
    schema,
    valuePath,
    root,
    seenRefs,
    evaluatedItems
  );
  if (prefixError) {
    return prefixError;
  }
  const extraError = validateJsonSchemaArrayExtraItems(
    value,
    schema,
    valuePath,
    root,
    seenRefs,
    evaluatedItems
  );
  if (extraError) {
    return extraError;
  }
  return validateJsonSchemaArrayUnevaluatedItems(
    value,
    schema,
    valuePath,
    root,
    seenRefs,
    evaluatedItems
  );
};

const parseString = function parseString(value) {
  try {
    return String.prototype.valueOf.call(value);
  } catch {
    return null;
  }
};

validateJsonSchemaValue = (
  value,
  schema,
  valuePath,
  rootSchema = schema,
  seenRefs = new Set()
) => {
  if (schema === true) {
    return null;
  }
  if (schema === false) {
    return `Invalid value for ${valuePath}: schema disallows value`;
  }
  const resolvedSchema = canonicalJsonSchema(schema);
  const root = canonicalJsonSchema(rootSchema || resolvedSchema);
  if (resolvedSchema === true) {
    return null;
  }
  if (resolvedSchema === false) {
    return `Invalid value for ${valuePath}: schema disallows value`;
  }
  if (!isRecord(resolvedSchema)) {
    return null;
  }
  const reference = schemaReferenceTarget(resolvedSchema, root, seenRefs);
  if (reference) {
    return validateJsonSchemaValue(
      value,
      reference.schema,
      valuePath,
      root,
      reference.seenRefs
    );
  }
  const compositionError = validateJsonSchemaComposition(
    value,
    resolvedSchema,
    valuePath,
    root,
    seenRefs
  );
  if (compositionError) {
    return compositionError;
  }
  if (value === null && schemaAllowsNull(resolvedSchema, root, seenRefs)) {
    return null;
  }
  const types = schemaTypes(resolvedSchema);
  if (
    types.length &&
    !types.some((type) => jsonValueMatchesType(value, type))
  ) {
    return `Invalid value for ${valuePath}: expected ${types.join(" or ")}`;
  }
  const stringConstraintError = validateStringConstraints(
    value,
    resolvedSchema,
    valuePath
  );
  if (stringConstraintError) {
    return stringConstraintError;
  }
  const numberConstraintError = validateNumberConstraints(
    value,
    resolvedSchema,
    valuePath
  );
  if (numberConstraintError) {
    return numberConstraintError;
  }
  const objectError = validateJsonSchemaObjectValue(
    value,
    resolvedSchema,
    valuePath,
    root,
    seenRefs,
    types
  );
  if (objectError) {
    return objectError;
  }
  return validateJsonSchemaArrayValue(
    value,
    resolvedSchema,
    valuePath,
    root,
    seenRefs,
    types
  );
};

const clientToolPayloadIsComplete = function clientToolPayloadIsComplete(
  toolName,
  payload,
  clientTools = []
) {
  const tool = matchingClientToolByName(toolName, clientTools);
  if (!tool) {
    return true;
  }
  const schema = clientMcpInputSchema(tool.parameters);
  return validateJsonSchemaValue(payload, schema, tool.name, schema) === null;
};

const hasString = function hasString(args, ...keys) {
  return keys.some((key) => parseString(args[key])?.trim().length > 0);
};

const hasStringAllowEmpty = function hasStringAllowEmpty(args, ...keys) {
  return keys.some((key) => parseString(args[key]) !== null);
};

const hasGlobString = function hasGlobString(args, ...keys) {
  return keys.some((key) => {
    const value = parseString(args[key]);
    return value !== null && /[*?[\]{}]/u.test(value);
  });
};

const mcpProviderNameVariants = function mcpProviderNameVariants(provider) {
  const trimmed = parseString(provider)?.trim() || "";
  if (!trimmed) {
    return [];
  }
  const output = [];
  const append = (value) => {
    const candidate = String(value || "").trim();
    if (candidate && !output.includes(candidate)) {
      output.push(candidate);
    }
  };
  append(trimmed);
  for (const separator of [":", "/", "\\", "."]) {
    const pieces = trimmed.split(separator).filter(Boolean);
    if (pieces.length) {
      append(pieces.at(-1));
    }
  }
  for (const prefix of ["mcp__", "mcp_", "mcp-", "mcp:"]) {
    if (trimmed.toLowerCase().startsWith(prefix)) {
      append(trimmed.slice(prefix.length));
    }
  }
  return output;
};

const matchingClientToolForMcpCall = function matchingClientToolForMcpCall(
  args,
  clientTools = []
) {
  const provider = firstString(
    args,
    "providerIdentifier",
    "provider_identifier",
    "provider",
    "server",
    "serverName",
    "server_name"
  );
  const toolName = firstString(args, "toolName", "tool_name", "tool", "name");
  if (!toolName) {
    return null;
  }
  const candidates = new Set([toolName]);
  for (const variant of mcpProviderNameVariants(provider)) {
    candidates.add(`${variant}__${toolName}`);
    candidates.add(`${variant}_${toolName}`);
    candidates.add(`mcp__${variant}__${toolName}`);
    candidates.add(`mcp_${variant}_${toolName}`);
  }
  const normalizedCandidates = new Set([...candidates].map(normalizeToolName));
  return (
    clientTools.find((tool) =>
      normalizedCandidates.has(normalizeToolName(tool?.name))
    ) || null
  );
};

const schemaPropertyName = function schemaPropertyName(properties, keys) {
  const normalizedKeys = new Set(keys.map(normalizeToolName));
  return (
    properties.find((property) =>
      normalizedKeys.has(normalizeToolName(property))
    ) || ""
  );
};

const mcpProviderKeys = function mcpProviderKeys() {
  return [
    "providerIdentifier",
    "provider_identifier",
    "provider",
    "server",
    "serverName",
    "server_name",
  ];
};

const mcpToolNameKeys = function mcpToolNameKeys() {
  return ["toolName", "tool_name", "tool", "name"];
};

const mcpPayloadKeys = function mcpPayloadKeys() {
  return [
    "args",
    "arguments",
    "input",
    "parameters",
    "params",
    "payload",
    "data",
  ];
};

const clientToolLooksLikeMcpWrapper = function clientToolLooksLikeMcpWrapper(
  tool
) {
  if (!tool || parseString(tool.name) === null) {
    return false;
  }
  const schema = clientMcpInputSchema(tool.parameters);
  const properties = isRecord(schema.properties)
    ? Object.keys(schema.properties)
    : [];
  return Boolean(
    schemaPropertyName(properties, mcpProviderKeys()) &&
    schemaPropertyName(properties, mcpToolNameKeys()) &&
    schemaPropertyName(properties, mcpPayloadKeys())
  );
};

const matchingClientMcpWrapperTool = function matchingClientMcpWrapperTool(
  args,
  clientTools = []
) {
  const provider = firstString(
    args,
    "providerIdentifier",
    "provider_identifier",
    "provider",
    "server",
    "serverName",
    "server_name"
  );
  const toolName = firstString(args, "toolName", "tool_name", "tool", "name");
  if (!provider || !toolName) {
    return null;
  }
  return (
    clientTools.find((tool) => clientToolLooksLikeMcpWrapper(tool)) || null
  );
};

const clientMcpWrapperArguments = function clientMcpWrapperArguments(
  args,
  schema
) {
  const properties = isRecord(schema.properties)
    ? Object.keys(schema.properties)
    : [];
  const providerKey = schemaPropertyName(properties, mcpProviderKeys());
  const toolKey = schemaPropertyName(properties, mcpToolNameKeys());
  const payloadKey = schemaPropertyName(properties, mcpPayloadKeys());
  if (!providerKey || !toolKey || !payloadKey) {
    return null;
  }
  const provider = firstString(args, ...mcpProviderKeys());
  const toolName = firstString(args, ...mcpToolNameKeys());
  if (!provider || !toolName) {
    return null;
  }
  return {
    [providerKey]: provider,
    [toolKey]: toolName,
    [payloadKey]: clientMcpPayloadArguments(args),
  };
};

const hasStringOrStringArray = function hasStringOrStringArray(args, ...keys) {
  return keys.some((key) => {
    const value = args[key];
    const stringValue = parseString(value);
    if (stringValue !== null) {
      return stringValue.trim().length > 0;
    }
    return (
      Array.isArray(value) &&
      value.some((item) => parseString(item)?.trim().length > 0)
    );
  });
};

const FILE_PATH_PAYLOAD_KEYS = [
  "path",
  "filePath",
  "file_path",
  "targetFile",
  "target_file",
];

const toolPayloadPathOnlyComplete = function toolPayloadPathOnlyComplete(
  payload
) {
  return hasString(payload, ...FILE_PATH_PAYLOAD_KEYS);
};

const toolPayloadWriteComplete = function toolPayloadWriteComplete(payload) {
  return (
    toolPayloadPathOnlyComplete(payload) &&
    hasStringAllowEmpty(
      payload,
      "fileText",
      "file_text",
      "content",
      "contents",
      "text",
      "data"
    )
  );
};

const toolPayloadEditComplete = function toolPayloadEditComplete(payload) {
  return (
    toolPayloadPathOnlyComplete(payload) &&
    (hasStringAllowEmpty(
      payload,
      "patchContent",
      "patch_content",
      "streamContent",
      "stream_content"
    ) ||
      (hasStringAllowEmpty(
        payload,
        "oldText",
        "old_text",
        "oldString",
        "old_string",
        "old_str"
      ) &&
        hasStringAllowEmpty(
          payload,
          "newText",
          "new_text",
          "newString",
          "new_string",
          "replacement"
        )))
  );
};

const toolPayloadShellComplete = function toolPayloadShellComplete(payload) {
  return hasString(payload, "command", "cmd", "script", "input");
};

const toolPayloadGlobComplete = function toolPayloadGlobComplete(payload) {
  return (
    hasString(
      payload,
      "globPattern",
      "glob_pattern",
      "pattern",
      "fileGlob",
      "file_glob",
      "includePattern",
      "include_pattern",
      "glob"
    ) ||
    hasGlobString(
      payload,
      "targetDirectory",
      "target_directory",
      "targeting",
      "path",
      "directory",
      "dir",
      "root",
      "basePath",
      "base_path"
    )
  );
};

const toolPayloadTaskComplete = function toolPayloadTaskComplete(payload) {
  return (
    hasString(payload, "description", "desc", "summary") &&
    hasString(payload, "prompt", "instructions", "input", "query")
  );
};

hasArray = (args, ...keys) => keys.some((key) => Array.isArray(args[key]));

const toolPayloadCreatePlanComplete = function toolPayloadCreatePlanComplete(
  payload
) {
  return (
    hasString(payload, "plan", "overview", "name", "title", "description") ||
    hasArray(
      payload,
      "todos",
      "todoList",
      "todo_list",
      "todoItems",
      "todo_items",
      "items",
      "tasks",
      "taskList",
      "task_list",
      "phases"
    )
  );
};

const toolPayloadGenerateImageComplete =
  function toolPayloadGenerateImageComplete(payload) {
    return hasString(
      payload,
      "description",
      "desc",
      "summary",
      "prompt",
      "input",
      "query"
    );
  };

const toolPayloadRecordScreenComplete =
  function toolPayloadRecordScreenComplete(payload) {
    return hasString(payload, "mode", "action", "operation", "op");
  };

const TOOL_PAYLOAD_COMPLETE_CHECKERS = new Map(
  [
    [
      [
        "write",
        "writefile",
        "create",
        "createfile",
        "overwrite",
        "overwritefile",
      ],
      toolPayloadWriteComplete,
    ],
    [
      [
        "edit",
        "editfile",
        "replace",
        "replacefile",
        "strreplace",
        "strreplacefile",
      ],
      toolPayloadEditComplete,
    ],
    [
      [
        "read",
        "readfile",
        "open",
        "openfile",
        "delete",
        "deletefile",
        "remove",
        "removefile",
      ],
      toolPayloadPathOnlyComplete,
    ],
    [["run", "runcommand", "shell", "bash"], toolPayloadShellComplete],
    [
      ["glob", "fileglob", "find", "findfile", "findfiles"],
      toolPayloadGlobComplete,
    ],
    [
      ["grep", "search", "query"],
      (payload) => hasString(payload, "pattern", "query", "search", "regex"),
    ],
    [["task", "subagent", "subagenttask"], toolPayloadTaskComplete],
    [
      ["createplan", "plan", "planupdate", "setplan"],
      toolPayloadCreatePlanComplete,
    ],
    [
      ["generateimage", "imagegeneration", "imagegen"],
      toolPayloadGenerateImageComplete,
    ],
    [
      ["recordscreen", "screenrecord", "screenrecording"],
      toolPayloadRecordScreenComplete,
    ],
    [
      ["semsearch", "semanticsearch"],
      (payload) =>
        hasString(
          payload,
          "query",
          "pattern",
          "search",
          "searchQuery",
          "search_query",
          "semanticQuery",
          "semantic_query",
          "prompt"
        ),
    ],
    [
      ["todowrite", "todos", "updatetodos"],
      (payload) =>
        hasArray(
          payload,
          "todos",
          "todoList",
          "todo_list",
          "todoItems",
          "todo_items",
          "items",
          "tasks",
          "taskList",
          "task_list"
        ),
    ],
  ].flatMap(([names, checker]) => names.map((name) => [name, checker]))
);

const toolPayloadLooksComplete = function toolPayloadLooksComplete(
  toolName,
  payload
) {
  const checker = TOOL_PAYLOAD_COMPLETE_CHECKERS.get(
    canonicalToolName(toolName)
  );
  return checker ? checker(payload) : false;
};

const mcpWrapperPayloadLooksComplete = function mcpWrapperPayloadLooksComplete(
  args
) {
  const toolName = firstString(args, ...mcpToolNameKeys());
  return toolPayloadLooksComplete(toolName, clientMcpPayloadArguments(args));
};

const isForwardableMcpToolCall = function isForwardableMcpToolCall(
  args,
  clientTools
) {
  if (
    !hasString(args, "providerIdentifier", "provider", "server") ||
    !hasString(args, "toolName", "tool", "name")
  ) {
    return false;
  }
  return mcpClientToolPayloadIsComplete(args, clientTools);
};

mcpClientToolPayloadIsComplete = (args, clientTools = []) => {
  const tool = matchingClientToolForMcpCall(args, clientTools);
  if (tool) {
    const payload = clientMcpPayloadArguments(args);
    const schema = clientMcpInputSchema(tool.parameters);
    return validateJsonSchemaValue(payload, schema, tool.name, schema) === null;
  }
  const wrapper = matchingClientMcpWrapperTool(args, clientTools);
  if (!wrapper) {
    return false;
  }
  const schema = clientMcpInputSchema(wrapper.parameters);
  const wrapperArgs = clientMcpWrapperArguments(args, schema);
  if (!wrapperArgs) {
    return false;
  }
  if (
    validateJsonSchemaValue(wrapperArgs, schema, wrapper.name, schema) === null
  ) {
    return true;
  }
  return mcpWrapperPayloadLooksComplete(args);
};

const isForwardableSDKToolCall = function isForwardableSDKToolCall(
  toolCall,
  clientTools = []
) {
  const args = toolCall.arguments || {};
  if (matchingClientToolByName(toolCall.name, clientTools)) {
    return clientToolPayloadIsComplete(toolCall.name, args, clientTools);
  }
  const canonical = canonicalToolName(toolCall.name);
  if (canonical === "mcp") {
    return isForwardableMcpToolCall(args, clientTools);
  }
  if (canonical === "ls") {
    return true;
  }
  if (canonical === "readlints") {
    return hasStringOrStringArray(
      args,
      "paths",
      "files",
      "filePaths",
      "file_paths",
      "path",
      "file_path",
      "filePath",
      "filename",
      "file"
    );
  }
  return toolPayloadLooksComplete(toolCall.name, args);
};

const registerActiveClientToolCapture =
  function registerActiveClientToolCapture(cacheKey, handler) {
    if (!activeClientToolCaptures.has(cacheKey)) {
      activeClientToolCaptures.set(cacheKey, new Set());
    }
    const handlers = activeClientToolCaptures.get(cacheKey);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        activeClientToolCaptures.delete(cacheKey);
      }
    };
  };

const sdkModelSelection = function sdkModelSelection(model) {
  const normalized = normalizeModel(parseString(model) || "");
  if (normalized === "composer-2.5" || normalized === "composer-2.5-fast") {
    return { id: "default" };
  }
  return { id: normalized };
};

const localAgentCreateOptions = function localAgentCreateOptions(input) {
  return {
    apiKey: input.apiKey,
    local: {
      cwd: input.workingDirectory,
    },
    model: sdkModelSelection(input.model),
    name: "API for Cursor local bridge",
  };
};

const evictAgents = function evictAgents() {
  while (agentCache.size > maxAgents) {
    const sorted = [...agentCache.entries()].toSorted(
      (a, b) => a[1].touchedAt - b[1].touchedAt
    );
    const [oldestKey, oldestEntry] = sorted[0] ?? [];
    if (!oldestKey || !oldestEntry) {
      return;
    }
    agentCache.delete(oldestKey);
    forceNextRunAgentKeys.delete(oldestKey);
    try {
      oldestEntry.agent.close();
    } catch {
      ignoreError();
    }
  }
};

const getAgent = async function getAgent(input) {
  const cacheKey = agentCacheKey(input);
  const cached = agentCache.get(cacheKey);
  if (cached) {
    cached.touchedAt = Date.now();
    return { agent: cached.agent, cacheKey, cached: true };
  }
  const agent = await Agent.create(localAgentCreateOptions(input));
  agentCache.set(cacheKey, { agent, touchedAt: Date.now() });
  evictAgents();
  return { agent, cacheKey, cached: false };
};

const clientMcpToolDefinitions = function clientMcpToolDefinitions(
  clientTools = []
) {
  const pathProperty = {
    description: "File or directory path for the outer client.",
    type: "string",
  };
  const fallbackTools = [
    {
      description: "Forward a file write to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: {
          fileText: { type: "string" },
          path: pathProperty,
        },
        required: ["path", "fileText"],
        type: "object",
      },
      name: "client_write",
    },
    {
      description:
        "Forward a shell command to the outer client. The bridge never executes it locally.",
      inputSchema: {
        additionalProperties: true,
        properties: {
          command: { type: "string" },
          timeout: { type: "number" },
          workingDirectory: { type: "string" },
        },
        required: ["command"],
        type: "object",
      },
      name: "client_shell",
    },
    {
      description: "Forward a file read to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: {
          limit: { type: "number" },
          offset: { type: "number" },
          path: pathProperty,
        },
        required: ["path"],
        type: "object",
      },
      name: "client_read",
    },
    {
      description: "Forward a text replacement edit to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: {
          newString: { type: "string" },
          oldString: { type: "string" },
          path: pathProperty,
        },
        required: ["path", "oldString", "newString"],
        type: "object",
      },
      name: "client_edit",
    },
    {
      description: "Forward a file or directory delete to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: { path: pathProperty },
        required: ["path"],
        type: "object",
      },
      name: "client_delete",
    },
    {
      description: "Forward a glob file search to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: {
          globPattern: { type: "string" },
          targetDirectory: { type: "string" },
        },
        required: ["globPattern"],
        type: "object",
      },
      name: "client_glob",
    },
    {
      description: "Forward a text search to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: {
          glob: { type: "string" },
          path: { type: "string" },
          pattern: { type: "string" },
        },
        required: ["pattern"],
        type: "object",
      },
      name: "client_grep",
    },
    {
      description: "Forward a directory listing to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: { path: { type: "string" } },
        type: "object",
      },
      name: "client_ls",
    },
    {
      description: "Forward diagnostics/lint reads to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: {
          paths: { items: { type: "string" }, type: "array" },
        },
        required: ["paths"],
        type: "object",
      },
      name: "client_read_lints",
    },
    {
      description: "Forward semantic code search to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: {
          query: { type: "string" },
          targetDirectories: { items: { type: "string" }, type: "array" },
        },
        required: ["query"],
        type: "object",
      },
      name: "client_sem_search",
    },
    {
      description: "Forward todo list updates to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: {
          todos: {
            items: { additionalProperties: true, type: "object" },
            type: "array",
          },
        },
        required: ["todos"],
        type: "object",
      },
      name: "client_todo_write",
    },
    {
      description: "Forward a subagent/task request to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: {
          agentId: { type: "string" },
          attachments: { items: { type: "string" }, type: "array" },
          description: { type: "string" },
          mode: { type: "string" },
          model: { type: "string" },
          prompt: { type: "string" },
          resume: { type: "string" },
          subagentType: {
            anyOf: [
              { type: "string" },
              { additionalProperties: true, type: "object" },
            ],
          },
        },
        required: ["description", "prompt"],
        type: "object",
      },
      name: "client_task",
    },
    {
      description:
        "Forward a plan creation/update request to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: {
          isProject: { type: "boolean" },
          name: { type: "string" },
          overview: { type: "string" },
          phases: {
            items: { additionalProperties: true, type: "object" },
            type: "array",
          },
          plan: { type: "string" },
          todos: {
            items: { additionalProperties: true, type: "object" },
            type: "array",
          },
        },
        type: "object",
      },
      name: "client_create_plan",
    },
    {
      description: "Forward an image generation request to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: {
          description: { type: "string" },
          filePath: pathProperty,
        },
        required: ["description"],
        type: "object",
      },
      name: "client_generate_image",
    },
    {
      description:
        "Forward a screen recording control request to the outer client.",
      inputSchema: {
        additionalProperties: true,
        properties: {
          mode: {
            enum: ["START_RECORDING", "SAVE_RECORDING", "DISCARD_RECORDING"],
            type: "string",
          },
        },
        required: ["mode"],
        type: "object",
      },
      name: "client_record_screen",
    },
  ];
  const tools = [];
  const seen = new Set();
  for (const tool of clientTools) {
    if (!tool.name || seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    tools.push({
      description:
        tool.description || `Forward ${tool.name} to the outer client.`,
      inputSchema: clientMcpInputSchema(tool.parameters),
      name: tool.name,
    });
  }
  for (const tool of fallbackTools) {
    if (seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    tools.push(tool);
  }
  return tools;
};

const clientForwardingMcpServers = function clientForwardingMcpServers(
  clientTools = [],
  cacheKey = ""
) {
  return {
    [clientMcpServerName]: {
      args: [import.meta.filename, clientMcpServerMode],
      command: process.execPath,
      env: {
        CURSOR_SDK_BRIDGE_AGENT_CACHE_KEY: cacheKey,
        CURSOR_SDK_BRIDGE_CALLBACK_TOKEN: bridgeToken,
        CURSOR_SDK_BRIDGE_CALLBACK_URL: `http://${host}:${port}${clientToolCallbackPath}`,
        CURSOR_SDK_BRIDGE_CLIENT_TOOLS_JSON: JSON.stringify(
          clientMcpToolDefinitions(clientTools)
        ),
      },
      type: "stdio",
    },
  };
};

const localAgentSendOptions = function localAgentSendOptions(
  input,
  optionsInput = {}
) {
  const options = {
    model: sdkModelSelection(input.model),
  };
  if (optionsInput.force === true) {
    options.local = { force: true };
  }
  if (input.clientTools.length > 0) {
    options.mcpServers = clientForwardingMcpServers(
      input.clientTools,
      agentCacheKey(input)
    );
  }
  return options;
};

const toolCallFromDelta = function toolCallFromDelta(update) {
  if (!isRecord(update)) {
    return null;
  }
  if (update.type !== "tool-call-started") {
    return null;
  }
  const { toolCall } = update;
  if (!isRecord(toolCall)) {
    return null;
  }
  return toolCall;
};

const isBenignCancellationError = function isBenignCancellationError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
};

const evictAgent = function evictAgent(cacheKey, agent) {
  const cached = agentCache.get(cacheKey);
  if (cached?.agent === agent) {
    agentCache.delete(cacheKey);
  }
  forceNextRunAgentKeys.delete(cacheKey);
  try {
    agent.close();
  } catch {
    ignoreError();
  }
};

const firstRecord = function firstRecord(...values) {
  return values.find((value) => isRecord(value)) || {};
};

const sdkRunFailureSummary = function sdkRunFailureSummary(result) {
  const source = firstRecord(
    result?.error,
    result?.cause,
    result?.details,
    result?.result
  );
  const message = firstNonEmptyString(
    source?.message,
    source?.rawMessage,
    source?.error,
    source?.details,
    parseString(result?.result) ?? undefined
  );
  const code = firstNonEmptyString(source?.code, result?.code);
  return {
    code,
    message,
    retryable: isRetryableSDKRunError(source) || (!message && !code),
    status: result?.status,
  };
};

const sdkRunFailureError = function sdkRunFailureError(result) {
  const summary = sdkRunFailureSummary(result);
  const error = new HttpError(
    summary.message || "Cursor SDK run failed",
    summary.retryable ? 503 : 502,
    "cursor_sdk_error"
  );
  error.rawMessage = summary.message;
  error.isRetryable = summary.retryable;
  error.cause = summary;
  const statusCode = summary.code ? ` (${summary.code})` : "";
  console.warn(`Cursor SDK run returned error status${statusCode}.`);
  return error;
};

const stripFinalMarker = function stripFinalMarker(text) {
  const trimmedText = text.trimEnd();
  const lowerText = trimmedText.toLowerCase();
  const markers = [
    "<final_answer>",
    "</final_answer>",
    "<answer>",
    "</answer>",
  ];
  const marker = markers.find((candidate) => lowerText.endsWith(candidate));
  return (marker ? trimmedText.slice(0, -marker.length) : trimmedText).trim();
};

const cancelActiveRunSafely = async function cancelActiveRunSafely(run) {
  try {
    await run.cancel();
  } catch {
    ignoreError();
  }
};

const appendAssistantStreamText = function appendAssistantStreamText(
  block,
  state,
  onEvent
) {
  if (block?.type !== "text" || parseString(block.text) === null) {
    return;
  }
  state.text += block.text;
  if (onEvent && block.text) {
    onEvent({ text: block.text, type: "text" });
  }
};

const consumeRunStream = async function consumeRunStream(
  run,
  captureToolCall,
  state,
  onEvent
) {
  const streamIterator = run.stream()[Symbol.asyncIterator]();
  const pumpStream = async function pumpStream() {
    const next = await streamIterator.next();
    if (next.done) {
      return;
    }
    const event = next.value;
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        appendAssistantStreamText(block, state, onEvent);
      }
      return pumpStream();
    }
    if (event.type === "tool_call") {
      if (event.status && event.status !== "running") {
        return pumpStream();
      }
      await captureToolCall(
        { args: event.args, type: event.name },
        { waitForCancel: false }
      );
      if (state.capturedToolCall) {
        return;
      }
      return pumpStream();
    }
    return pumpStream();
  };
  await pumpStream();
};

const resolveLocalAgentPrompt = function resolveLocalAgentPrompt(
  agentEntry,
  input
) {
  if (agentEntry.cached && input.incrementalPrompt) {
    return input.incrementalPrompt;
  }
  return input.prompt;
};

const runLocalAgentBody = async function runLocalAgentBody(
  input,
  onRun,
  onEvent
) {
  const cacheKey = agentCacheKey(input);
  let agentEntry = null;
  let run;
  const runState = { capturedToolCall: null, text: "" };
  let cancelRequested = false;
  const captureToolCall = async (toolCall, options = {}) => {
    if (runState.capturedToolCall || !toolCall) {
      return;
    }
    const normalized = normalizeSDKToolCall(toolCall, input.clientTools);
    if (
      !normalized ||
      !isForwardableSDKToolCall(normalized, input.clientTools)
    ) {
      return;
    }
    runState.capturedToolCall = normalized;
    if (onEvent) {
      onEvent({ toolCall: runState.capturedToolCall, type: "tool_call" });
    }
    cancelRequested = true;
    if (run) {
      const cancellation = cancelActiveRunSafely(run);
      if (options.waitForCancel === true) {
        await cancellation;
      }
    }
  };
  const unregisterCapture = registerActiveClientToolCapture(
    cacheKey,
    async (toolCall) => {
      await captureToolCall(toolCall, { waitForCancel: false });
      return runState.capturedToolCall !== null;
    }
  );
  try {
    agentEntry = await getAgent(input);
    const { agent } = agentEntry;
    const prompt = resolveLocalAgentPrompt(agentEntry, input);
    const force = forceNextRunAgentKeys.delete(cacheKey);
    run = await agent.send(prompt, {
      ...localAgentSendOptions(input, { force }),
      idempotencyKey: input.requestId,
      onDelta: async ({ update }) => {
        const toolCall = toolCallFromDelta(update);
        if (toolCall) {
          await captureToolCall(toolCall);
        }
      },
    });
    onRun(run);
    if (cancelRequested) {
      await cancelActiveRunSafely(run);
    }
    if (!runState.capturedToolCall) {
      await consumeRunStream(run, captureToolCall, runState, onEvent);
    }
  } catch (error) {
    if (
      !runState.capturedToolCall &&
      !(cancelRequested && isBenignCancellationError(error))
    ) {
      throw error;
    }
  } finally {
    unregisterCapture();
  }
  if (runState.capturedToolCall) {
    if (agentEntry) {
      forceNextRunAgentKeys.add(agentEntry.cacheKey);
    }
    return {
      agentID: agentEntry?.agent.agentId || "",
      runID: run?.id || input.requestId,
      status: "tool_call",
      text: "",
      toolCalls: [runState.capturedToolCall],
    };
  }
  const result = await run.wait();
  if (result.status === "error") {
    if (agentEntry) {
      evictAgent(agentEntry.cacheKey, agentEntry.agent);
    }
    throw sdkRunFailureError(result);
  }
  const resultText = parseString(result.result);
  if (!runState.text && resultText !== null) {
    runState.text = resultText;
  }
  return {
    agentID: agentEntry?.agent.agentId || "",
    runID: run.id,
    status: result.status,
    text: stripFinalMarker(runState.text),
    toolCalls: [],
  };
};

const evictCachedAgent = function evictCachedAgent(input) {
  const cacheKey = agentCacheKey(input);
  const cached = agentCache.get(cacheKey);
  if (cached) {
    evictAgent(cacheKey, cached.agent);
  }
};

const failWhenAborted = async function failWhenAborted(
  signal,
  createError,
  onAbort
) {
  if (signal.aborted) {
    if (onAbort) {
      await onAbort();
    }
    throw createError();
  }
  await once(signal, "abort");
  if (onAbort) {
    await onAbort();
  }
  throw createError();
};

const retryDelayMs = function retryDelayMs(attempt) {
  return Math.min(5000, retryBaseDelayMs * 2 ** attempt);
};

const runLocalAgentUnlocked = async function runLocalAgentUnlocked(
  input,
  onEvent
) {
  const attemptRun = async function attemptRun(attempt) {
    let activeRun = null;
    let emittedEvent = false;
    const emit = onEvent
      ? (event) => {
          emittedEvent = true;
          return onEvent(event);
        }
      : undefined;
    const work = runLocalAgentBody(
      input,
      (run) => {
        activeRun = run;
      },
      emit
    );
    const timeoutFailure = failWhenAborted(
      AbortSignal.timeout(runTimeoutMs),
      () =>
        new HttpError(
          "Cursor SDK bridge run timed out.",
          504,
          "cursor_sdk_timeout"
        ),
      async () => {
        if (activeRun) {
          await cancelActiveRunSafely(activeRun);
        }
      }
    );
    try {
      return await Promise.race([work, timeoutFailure]);
    } catch (error) {
      try {
        await work;
      } catch {
        ignoreError();
      }
      const shouldRetry =
        attempt < maxRunRetries &&
        !emittedEvent &&
        isRetryableSDKRunError(error);
      if (!shouldRetry) {
        throw error;
      }
      if (activeRun) {
        await cancelActiveRunSafely(activeRun);
      }
      evictCachedAgent(input);
      console.warn(
        `Retrying Cursor SDK run after retryable upstream error (${attempt + 1}/${maxRunRetries}).`
      );
      await sleepMs(retryDelayMs(attempt));
      return attemptRun(attempt + 1);
    }
  };
  return await attemptRun(0);
};

const runLocalAgent = function runLocalAgent(input, onEvent) {
  return runExclusiveForAgent(input, () =>
    runLocalAgentUnlocked(input, onEvent)
  );
};

const streamLocalAgent = async function streamLocalAgent(input, response) {
  let closed = false;
  const markClosed = () => {
    closed = true;
  };
  const { socket } = response;
  response.on("close", markClosed);
  response.on("error", markClosed);
  socket?.on?.("error", markClosed);
  response.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache, no-transform",
    "Content-Type": "application/x-ndjson; charset=utf-8",
  });
  const emit = (event) => {
    if (closed) {
      return false;
    }
    const wrote = writeNdjson(response, event);
    if (!wrote) {
      closed = true;
    }
    return wrote;
  };
  try {
    const output = await runLocalAgent(input, emit);
    emit({ output, type: "done" });
  } catch (error) {
    emit({ error: openAiError(error).error, type: "error" });
  } finally {
    response.off("close", markClosed);
    response.off("error", markClosed);
    socket?.off?.("error", markClosed);
    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }
  }
};

const buildLocalAgentInput = function buildLocalAgentInput(body) {
  const apiKey = requiredString(body.apiKey, "apiKey");
  const prompt = requiredString(body.prompt, "prompt");
  const incrementalPromptValue = parseString(body.incrementalPrompt);
  const incrementalPrompt =
    (incrementalPromptValue?.trim() && incrementalPromptValue) || prompt;
  const promptAlreadyPrepared = body.promptAlreadyPrepared === true;
  const model = normalizeModel(parseString(body.model) || "");
  const sessionKeyValue = parseString(body.sessionKey);
  const sessionKey = sessionKeyValue || crypto.randomUUID();
  const workingDirectory = sdkWorkingDirectory(body.workingDirectory);
  const requestIdValue = parseString(body.requestId);
  const requestId = requestIdValue || crypto.randomUUID();
  const clientTools = parseClientTools(body.tools);
  return {
    input: {
      apiKey,
      clientTools,
      incrementalPrompt:
        (promptAlreadyPrepared && incrementalPrompt) ||
        bridgePrompt(incrementalPrompt, clientTools),
      model,
      prompt:
        (promptAlreadyPrepared && prompt) || bridgePrompt(prompt, clientTools),
      requestId,
      sessionKey,
      workingDirectory,
    },
    streamEvents: body.streamEvents === true,
  };
};

const handleSdkRunRequest = async function handleSdkRunRequest(
  request,
  response
) {
  if (bridgeToken && bearerToken(request) !== bridgeToken) {
    writeJson(
      response,
      openAiError(new HttpError("Invalid bridge token", 401, "unauthorized")),
      401
    );
    return;
  }
  const body = await readJsonBody(request);
  const { input, streamEvents } = buildLocalAgentInput(body);
  if (streamEvents) {
    await streamLocalAgent(input, response);
    return;
  }
  const output = await runLocalAgent(input);
  writeJson(response, output);
};

const handleRequest = async function handleRequest(request, response) {
  const hostHeader = request.headers.host || `${host}:${port}`;
  const url = new URL(request.url || "/", `http://${hostHeader}`);
  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, { agents: agentCache.size, ok: true });
    return;
  }
  if (request.method === "POST" && url.pathname === clientToolCallbackPath) {
    await handleClientToolCallback(request, response);
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/sdk") {
    writeJson(
      response,
      openAiError(new HttpError("Not found", 404, "not_found")),
      404
    );
    return;
  }
  await handleSdkRunRequest(request, response);
};

const startServer = function startServer() {
  if (server) {
    return server;
  }
  server = http.createServer(async (request, response) => {
    try {
      await handleRequest(request, response);
    } catch (error) {
      writeJson(response, openAiError(error), statusFromError(error));
    }
  });
  server.listen(port, host, () => {
    console.log(
      `Cursor SDK local-agent bridge listening on http://${host}:${port}/sdk`
    );
  });
  return server;
};

const isBenignPipeError = function isBenignPipeError(error) {
  return error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED";
};

const validateClientMcpToolCall = function validateClientMcpToolCall(
  tools,
  toolName,
  input = {}
) {
  const name = parseString(toolName);
  if (!name?.trim()) {
    return "Missing MCP tool name.";
  }
  const tool = Array.isArray(tools)
    ? tools.find((candidate) => isRecord(candidate) && candidate.name === name)
    : null;
  if (!tool) {
    return `Unknown client MCP forwarding tool: ${toolName}`;
  }
  const schema = canonicalJsonSchema(
    isRecord(tool.inputSchema) ? tool.inputSchema : {}
  );
  const args = isRecord(input) ? input : {};
  return validateJsonSchemaValue(args, schema, name, schema);
};

const notifyParentToolCall = async function notifyParentToolCall({
  callbackUrl,
  callbackToken,
  callbackCacheKey,
  toolName,
  input,
}) {
  if (!callbackUrl || !callbackCacheKey) {
    return true;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const headers = { "Content-Type": "application/json" };
    if (callbackToken) {
      headers.Authorization = `Bearer ${callbackToken}`;
    }
    const response = await fetch(callbackUrl, {
      body: JSON.stringify({
        arguments: isRecord(input) ? input : {},
        cacheKey: callbackCacheKey,
        toolName,
      }),
      headers,
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    let body = {};
    try {
      body = await response.json();
    } catch {
      ignoreError();
    }
    return body && body.accepted === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const runClientForwardingMcpServer =
  async function runClientForwardingMcpServer({
    tools,
    callbackUrl,
    callbackToken,
    callbackCacheKey,
    input = process.stdin,
    output = process.stdout,
  }) {
    const rl = readline.createInterface({ input });
    let outputClosed = false;
    const writeOutput = (payload) => {
      if (outputClosed) {
        return false;
      }
      try {
        return output.write(payload);
      } catch (error) {
        if (!isBenignPipeError(error)) {
          throw error;
        }
        outputClosed = true;
        return false;
      }
    };
    output.on?.("error", (error) => {
      outputClosed = true;
      if (!isBenignPipeError(error)) {
        process.exitCode = 1;
      }
    });
    const send = (id, result) => {
      if (id === undefined || id === null) {
        return;
      }
      writeOutput(`${JSON.stringify({ id, jsonrpc: "2.0", result })}\n`);
    };
    const sendError = (id, message) => {
      if (id === undefined || id === null) {
        return;
      }
      writeOutput(
        `${JSON.stringify({ error: { code: -32_000, message }, id, jsonrpc: "2.0" })}\n`
      );
    };
    const pending = new Set();
    const handleLine = async (line) => {
      if (!line.trim()) {
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (
        !message.id &&
        String(message.method || "").startsWith("notifications/")
      ) {
        return;
      }
      if (message.method === "initialize") {
        send(message.id, {
          capabilities: { tools: {} },
          protocolVersion: "2024-11-05",
          serverInfo: { name: "api-for-cursor-client-tools", version: "0.1.0" },
        });
        return;
      }
      if (message.method === "tools/list") {
        send(message.id, { tools });
        return;
      }
      if (message.method === "tools/call") {
        const params = message.params || {};
        const toolName = params.name || params.toolName;
        const toolInput = params.arguments || params.input || {};
        const validationError = validateClientMcpToolCall(
          tools,
          toolName,
          toolInput
        );
        if (validationError) {
          sendError(message.id, validationError);
          return;
        }
        const accepted = await notifyParentToolCall({
          callbackCacheKey,
          callbackToken,
          callbackUrl,
          input: toolInput,
          toolName,
        });
        if (!accepted) {
          sendError(
            message.id,
            "Outer client callback unavailable for forwarded tool call."
          );
          return;
        }
        send(message.id, {
          content: [{ text: "FORWARDED_TO_OUTER_CLIENT", type: "text" }],
          isError: false,
        });
        return;
      }
      sendError(message.id, `Unsupported MCP method: ${message.method}`);
    };
    const enqueueLine = async function enqueueLine(line) {
      try {
        await handleLine(line);
      } catch (error) {
        if (!isBenignPipeError(error)) {
          process.exitCode = 1;
        }
      }
    };
    rl.on("line", (line) => {
      pending.add(enqueueLine(line));
    });
    await once(rl, "close");
    await Promise.allSettled(pending);
  };

const parseClientMcpToolsJSON = function parseClientMcpToolsJSON(value) {
  const serializedTools = parseString(value);
  if (!serializedTools?.trim()) {
    return clientMcpToolDefinitions([]);
  }
  try {
    const parsed = JSON.parse(serializedTools);
    return Array.isArray(parsed) ? parsed : clientMcpToolDefinitions([]);
  } catch {
    return clientMcpToolDefinitions([]);
  }
};

const runClientForwardingMcpServerFromEnvironment =
  async function runClientForwardingMcpServerFromEnvironment() {
    await runClientForwardingMcpServer({
      callbackCacheKey: process.env.CURSOR_SDK_BRIDGE_AGENT_CACHE_KEY || "",
      callbackToken: process.env.CURSOR_SDK_BRIDGE_CALLBACK_TOKEN || "",
      callbackUrl: process.env.CURSOR_SDK_BRIDGE_CALLBACK_URL || "",
      tools: parseClientMcpToolsJSON(
        process.env.CURSOR_SDK_BRIDGE_CLIENT_TOOLS_JSON
      ),
    });
  };

const clientForwardingMcpServerSource =
  function clientForwardingMcpServerSource(clientTools = []) {
    const tools = JSON.stringify(clientMcpToolDefinitions(clientTools));
    return `
const readline = require("node:readline");
const tools = ${tools};
const callbackUrl = process.env.CURSOR_SDK_BRIDGE_CALLBACK_URL || "";
const callbackToken = process.env.CURSOR_SDK_BRIDGE_CALLBACK_TOKEN || "";
const callbackCacheKey = process.env.CURSOR_SDK_BRIDGE_AGENT_CACHE_KEY || "";
const validateClientMcpToolCall = ${validateClientMcpToolCall.toString()};
const validateJsonSchemaValue = ${validateJsonSchemaValue.toString()};
const canonicalJsonSchema = ${canonicalJsonSchema.toString()};
const schemaHasStructuralKeyword = ${schemaHasStructuralKeyword.toString()};
const schemaReferenceTarget = ${schemaReferenceTarget.toString()};
const jsonPointerTarget = ${jsonPointerTarget.toString()};
const decodeJsonPointerSegment = ${decodeJsonPointerSegment.toString()};
const schemaTypes = ${schemaTypes.toString()};
const schemaAllowsNull = ${schemaAllowsNull.toString()};
const validateStringConstraints = ${validateStringConstraints.toString()};
const validateNumberConstraints = ${validateNumberConstraints.toString()};
const patternPropertySchemasForKey = ${patternPropertySchemasForKey.toString()};
const schemaEvaluatesObjectProperty = ${schemaEvaluatesObjectProperty.toString()};
const jsonValueMatchesType = ${jsonValueMatchesType.toString()};
const jsonValuesEqual = ${jsonValuesEqual.toString()};
const isRecord = ${isRecord.toString()};
const stableJson = ${stableJson.toString()};
const sortJson = ${sortJson.toString()};
const rl = readline.createInterface({ input: process.stdin });
let stdoutClosed = false;
function isBenignPipeError(error) {
  return error?.code === "EPIPE" || error?.code === "ERR_STREAM_DESTROYED";
}
function writeStdout(payload) {
  if (stdoutClosed) return false;
  try {
    return process.stdout.write(payload);
  } catch (error) {
    if (!isBenignPipeError(error)) throw error;
    stdoutClosed = true;
    return false;
  }
}
process.stdout.on("error", (error) => {
  stdoutClosed = true;
  if (isBenignPipeError(error)) process.exit(0);
  process.exitCode = 1;
});
function send(id, result) {
  if (id === undefined || id === null) return;
  writeStdout(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function sendError(id, message) {
  if (id === undefined || id === null) return;
  writeStdout(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\\n");
}
async function notifyParentToolCall(toolName, input) {
  if (!callbackUrl || !callbackCacheKey) return true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const headers = { "Content-Type": "application/json" };
    if (callbackToken) headers.Authorization = "Bearer " + callbackToken;
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        cacheKey: callbackCacheKey,
        toolName,
        arguments: input && typeof input === "object" && !Array.isArray(input) ? input : {}
      }),
      signal: controller.signal
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({}));
    return body && body.accepted === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message.id && String(message.method || "").startsWith("notifications/")) return;
  if (message.method === "initialize") {
    send(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "api-for-cursor-client-tools", version: "0.1.0" }
    });
  } else if (message.method === "tools/list") {
    send(message.id, { tools });
  } else if (message.method === "tools/call") {
    const params = message.params || {};
    const toolName = params.name || params.toolName;
    const input = params.arguments || params.input || {};
    const validationError = validateClientMcpToolCall(tools, toolName, input);
    if (validationError) {
      sendError(message.id, validationError);
      return;
    }
    const accepted = await notifyParentToolCall(toolName, input);
    if (!accepted) {
      sendError(message.id, "Outer client callback unavailable for forwarded tool call.");
      return;
    }
    send(message.id, {
      content: [{ type: "text", text: "FORWARDED_TO_OUTER_CLIENT" }],
      isError: false
    });
  } else {
    sendError(message.id, "Unsupported MCP method: " + message.method);
  }
});
`;
  };

const closeAndExit = function closeAndExit(code) {
  for (const entry of agentCache.values()) {
    try {
      entry.agent.close();
    } catch {
      ignoreError();
    }
  }
  server?.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 500).unref();
};

const installBridgeProcessHandlers = function installBridgeProcessHandlers() {
  process.on("unhandledRejection", (reason) => {
    if (isBenignCancellationError(reason) || isBenignPipeError(reason)) {
      return;
    }
    if (isRetryableSDKRunError(reason)) {
      console.warn("Ignored late retryable Cursor SDK upstream error.");
      return;
    }
    console.error(reason);
    closeAndExit(1);
  });
  process.on("uncaughtException", (error) => {
    if (isBenignCancellationError(error) || isBenignPipeError(error)) {
      return;
    }
    if (isRetryableSDKRunError(error)) {
      console.warn("Ignored late retryable Cursor SDK upstream error.");
      return;
    }
    console.error(error);
    closeAndExit(1);
  });
};

const isMainModule = function isMainModule() {
  return (
    process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename
  );
};

if (isMainModule()) {
  installBridgeProcessHandlers();
  if (process.argv.includes(clientMcpServerMode)) {
    await runClientForwardingMcpServerFromEnvironment();
  } else {
    startServer();
    process.on("SIGINT", () => closeAndExit(0));
    process.on("SIGTERM", () => closeAndExit(0));
  }
}

export {
  bridgePrompt,
  clientMcpToolDefinitions,
  clientForwardingMcpServerSource,
  localAgentCreateOptions,
  localAgentSendOptions,
  isForwardableSDKToolCall,
  isRetryableSDKRunError,
  normalizeSDKToolCall,
  normalizeModel,
  openAiError,
  runExclusiveForAgent,
  sdkRunFailureSummary,
  statusFromError,
  startServer,
  validateClientMcpToolCall,
  toolCallFromDelta,
};
