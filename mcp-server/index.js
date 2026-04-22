#!/usr/bin/env node
// =============================================================================
// Q-SYS ↔ Claude Desktop  —  MCP Bridge Server
// =============================================================================
// This process implements the Model Context Protocol (MCP) on stdio so that
// Claude Desktop can talk to it, and maintains a persistent TCP connection to
// the Q-SYS plugin's JSON-RPC server.
//
// Architecture:
//   Claude Desktop  ←─ stdio/MCP ─→  [this process]  ←─ TCP/JSON-RPC ─→  Q-SYS Plugin
//
// Environment variables:
//   QSYS_HOST  (default: 127.0.0.1)
//   QSYS_PORT  (default: 8765)
// =============================================================================

import { Server }              from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import net from "net";

// =============================================================================
// Configuration
// =============================================================================
const QSYS_HOST        = process.env.QSYS_HOST || "127.0.0.1";
const QSYS_PORT        = parseInt(process.env.QSYS_PORT || "8765", 10);
const CONNECT_TIMEOUT  = 8_000;   // ms
const REQUEST_TIMEOUT  = 12_000;  // ms
const RECONNECT_DELAY  = 3_000;   // ms

// =============================================================================
// Q-SYS TCP connection
// =============================================================================
let   qsysSocket      = null;
let   qsysConnected   = false;
let   messageBuffer   = "";
let   requestSeq      = 0;
const pendingRequests = new Map();   // id → { resolve, reject, timer }
let   reconnectTimer  = null;
let   lastWelcome     = null;        // welcome packet from Q-SYS plugin

/** Generate a unique request id */
function nextId() { return ++requestSeq; }

/** Low-level: write a JSON-RPC request to Q-SYS */
function writeToQSYS(obj) {
  if (!qsysSocket || !qsysConnected) return false;
  qsysSocket.write(JSON.stringify(obj) + "\n");
  return true;
}

/** Process one complete JSON line received from Q-SYS */
function handleQSYSLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Server-push event (heartbeat, connected notification, etc.)
  if (msg.event) {
    if (msg.event === "connected") lastWelcome = msg;
    stderr(`[Q-SYS event] ${msg.event}`);
    return;
  }

  // Response to a pending request
  if (msg.id !== undefined) {
    const pending = pendingRequests.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRequests.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message || "Q-SYS error"));
    else           pending.resolve(msg.result);
  }
}

/** Attempt to establish TCP connection to the Q-SYS plugin */
function connectToQSYS() {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    const timeout = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Connection timeout (${QSYS_HOST}:${QSYS_PORT})`));
    }, CONNECT_TIMEOUT);

    sock.connect(QSYS_PORT, QSYS_HOST, () => {
      clearTimeout(timeout);
      qsysSocket    = sock;
      qsysConnected = true;
      stderr(`[bridge] Connected to Q-SYS plugin at ${QSYS_HOST}:${QSYS_PORT}`);
      resolve(sock);
    });

    sock.on("data", (chunk) => {
      messageBuffer += chunk.toString("utf8");
      const lines = messageBuffer.split("\n");
      messageBuffer = lines.pop();           // keep partial last line
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) handleQSYSLine(trimmed);
      }
    });

    sock.on("error", (err) => {
      stderr(`[bridge] Socket error: ${err.message}`);
      qsysConnected = false;
      clearTimeout(timeout);
      rejectAllPending(err.message);
      if (!qsysSocket) reject(err);   // initial connect failed
    });

    sock.on("close", () => {
      stderr("[bridge] Connection closed — will retry");
      qsysSocket    = null;
      qsysConnected = false;
      rejectAllPending("Q-SYS connection closed");
      scheduleReconnect();
    });
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try { await connectToQSYS(); } catch { scheduleReconnect(); }
  }, RECONNECT_DELAY);
}

function rejectAllPending(reason) {
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
    pendingRequests.delete(id);
  }
}

/** High-level: send a JSON-RPC method to Q-SYS and await response */
async function qsysRequest(method, params = {}) {
  // Ensure connected
  if (!qsysConnected) {
    try { await connectToQSYS(); }
    catch (e) { throw new Error(`Q-SYS unreachable — ${e.message}`); }
  }

  return new Promise((resolve, reject) => {
    const id = nextId();
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Timeout waiting for '${method}'`));
    }, REQUEST_TIMEOUT);

    pendingRequests.set(id, { resolve, reject, timer });
    writeToQSYS({ id, method, params });
  });
}

// =============================================================================
// MCP Server definition
// =============================================================================
const mcpServer = new Server(
  { name: "qsys-designer-mcp", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } }
);

// =============================================================================
// Tool definitions
// =============================================================================
const TOOLS = [
  // ── Connectivity ────────────────────────────────────────────────────────────
  {
    name: "ping_qsys",
    description:
      "Check connectivity to the Q-SYS Designer plugin. Returns server info and design name.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // ── Design-level ────────────────────────────────────────────────────────────
  {
    name: "get_design_info",
    description:
      "Get metadata about the currently open Q-SYS design: name, platform, emulation state.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_components",
    description:
      "List ALL named components in the Q-SYS design with their type and properties. " +
      "Use this first to explore the design before drilling into individual components.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "find_components",
    description:
      "Search for components by partial name and/or type string (case-insensitive). " +
      "Omit both params to return all components.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Partial component name to search for (optional)",
        },
        type: {
          type: "string",
          description:
            'Partial component type to filter by, e.g. "gain", "mixer", "router" (optional)',
        },
      },
      required: [],
    },
  },

  // ── Component-level ─────────────────────────────────────────────────────────
  {
    name: "get_component",
    description:
      "Get full details of a specific named component including all its controls " +
      "(current value, string, min, max, disabled state).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact component name" },
      },
      required: ["name"],
    },
  },

  // ── Control-level ────────────────────────────────────────────────────────────
  {
    name: "get_control_value",
    description: "Read the current value/string of a single control within a component.",
    inputSchema: {
      type: "object",
      properties: {
        component: { type: "string", description: "Component name" },
        control:   { type: "string", description: "Control name"   },
      },
      required: ["component", "control"],
    },
  },
  {
    name: "set_control_value",
    description:
      "Write a value to a Q-SYS control. " +
      "Use valueType='number' for faders/levels, 'string' for text fields, 'boolean' for buttons.",
    inputSchema: {
      type: "object",
      properties: {
        component: { type: "string",  description: "Component name" },
        control:   { type: "string",  description: "Control name"   },
        value:     {                  description: "Value to write (number | string | boolean)" },
        valueType: {
          type: "string",
          enum: ["number", "string", "boolean"],
          description: "Data type of the value (default: number)",
        },
      },
      required: ["component", "control", "value"],
    },
  },
  {
    name: "set_multiple_controls",
    description:
      "Atomically write values to multiple controls in one call. " +
      "More efficient than calling set_control_value repeatedly.",
    inputSchema: {
      type: "object",
      properties: {
        controls: {
          type: "array",
          description: "Array of control write operations",
          items: {
            type: "object",
            properties: {
              component: { type: "string" },
              control:   { type: "string" },
              value:     {},
              valueType: { type: "string", enum: ["number", "string", "boolean"] },
            },
            required: ["component", "control", "value"],
          },
        },
      },
      required: ["controls"],
    },
  },
];

// =============================================================================
// List tools handler
// =============================================================================
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// =============================================================================
// Call tool handler
// =============================================================================
mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  const ok  = (obj)  => ({ content: [{ type: "text", text: fmt(obj) }] });
  const err = (msg)  => ({ content: [{ type: "text", text: `❌ Error: ${msg}` }], isError: true });

  try {
    switch (name) {

      // ── ping ─────────────────────────────────────────────────────────────
      case "ping_qsys": {
        const r = await qsysRequest("ping");
        return ok({
          status:     "online",
          designName: r.designName,
          timestamp:  r.timestamp,
          welcome:    lastWelcome,
        });
      }

      // ── get_design_info ──────────────────────────────────────────────────
      case "get_design_info": {
        const r = await qsysRequest("design.getInfo");
        return ok(r);
      }

      // ── list_components ──────────────────────────────────────────────────
      case "list_components": {
        const r    = await qsysRequest("design.listComponents");
        const list = (r.components || []);
        const summary = list
          .map(c => `• ${c.name}  [${c.type || "—"}]`)
          .join("\n");
        return ok({ count: list.length, summary, components: list });
      }

      // ── find_components ──────────────────────────────────────────────────
      case "find_components": {
        const r    = await qsysRequest("design.findComponents", {
          query: args.query || "",
          type:  args.type  || "",
        });
        const list = r.components || [];
        return ok({ count: list.length, components: list });
      }

      // ── get_component ────────────────────────────────────────────────────
      case "get_component": {
        if (!args.name) return err("'name' is required");
        const r = await qsysRequest("component.getDetails", { name: args.name });
        return ok(r);
      }

      // ── get_control_value ─────────────────────────────────────────────────
      case "get_control_value": {
        if (!args.component || !args.control) return err("'component' and 'control' are required");
        const r = await qsysRequest("control.getValue", {
          component: args.component,
          control:   args.control,
        });
        return ok(r);
      }

      // ── set_control_value ─────────────────────────────────────────────────
      case "set_control_value": {
        if (!args.component || !args.control || args.value === undefined)
          return err("'component', 'control', and 'value' are required");
        const r = await qsysRequest("control.setValue", {
          component: args.component,
          control:   args.control,
          value:     args.value,
          valueType: args.valueType || "number",
        });
        return ok({
          message:   `✅ Set ${args.component}.${args.control} = ${args.value}`,
          result:    r,
        });
      }

      // ── set_multiple_controls ─────────────────────────────────────────────
      case "set_multiple_controls": {
        if (!Array.isArray(args.controls) || args.controls.length === 0)
          return err("'controls' must be a non-empty array");
        const r = await qsysRequest("control.setMultiple", { controls: args.controls });
        const results = r.results || [];
        const failures = results.filter(x => !x.success);
        const summary  = failures.length === 0
          ? `✅ All ${results.length} controls written successfully`
          : `⚠️  ${results.length - failures.length}/${results.length} succeeded; ${failures.length} failed`;
        return ok({ summary, results });
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(e.message);
  }
});

// =============================================================================
// Resources: expose every Q-SYS component as a readable resource
// =============================================================================
mcpServer.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const r     = await qsysRequest("design.listComponents");
    const comps = r.components || [];
    return {
      resources: comps.map(c => ({
        uri:         `qsys://component/${encodeURIComponent(c.name)}`,
        name:        c.name,
        description: `Q-SYS component — type: ${c.type || "Unknown"}`,
        mimeType:    "application/json",
      })),
    };
  } catch {
    return { resources: [] };
  }
});

mcpServer.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const { uri } = req.params;
  const m = uri.match(/^qsys:\/\/component\/(.+)$/);
  if (!m) throw new Error(`Unrecognised resource URI: ${uri}`);
  const name = decodeURIComponent(m[1]);
  const r    = await qsysRequest("component.getDetails", { name });
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text:     JSON.stringify(r, null, 2),
    }],
  };
});

// =============================================================================
// Prompts: ready-made prompts that help Claude work with Q-SYS designs
// =============================================================================
const PROMPTS = [
  {
    name:        "review_design",
    description: "Comprehensive review of the Q-SYS design — lists all components and suggests improvements",
    arguments:   [],
  },
  {
    name:        "audit_levels",
    description: "Audit all gain/level/fader controls in the design and report current values",
    arguments:   [],
  },
  {
    name:        "find_and_set",
    description: "Find a component by name and interactively set one of its controls",
    arguments:   [
      { name: "component", description: "Component name to operate on", required: true },
      { name: "control",   description: "Control name to set",          required: true },
      { name: "value",     description: "Target value",                 required: true },
    ],
  },
];

mcpServer.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

mcpServer.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  if (name === "review_design") {
    return {
      description: "Review the entire Q-SYS design",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text:
            "Please perform a comprehensive review of this Q-SYS design.\n\n" +
            "Steps:\n" +
            "1. Call get_design_info to understand the design context.\n" +
            "2. Call list_components to enumerate every component.\n" +
            "3. For any suspicious or interesting components, call get_component for details.\n" +
            "4. Summarise: component inventory, potential issues, naming conventions, suggestions.\n",
        },
      }],
    };
  }

  if (name === "audit_levels") {
    return {
      description: "Audit all level/gain controls in the design",
      messages: [{
        role: "user",
        content: {
          type: "text",
          text:
            "Audit all gain and level controls in this Q-SYS design.\n\n" +
            "1. Call find_components with type='gain' and separately with type='mixer'.\n" +
            "2. For each found component, call get_component to retrieve its controls.\n" +
            "3. Report every gain/level/fader control with its current value, min, max.\n" +
            "4. Flag any controls that are muted, at minimum, or appear misconfigured.\n",
        },
      }],
    };
  }

  if (name === "find_and_set") {
    const comp  = args.component || "<component>";
    const ctrl  = args.control   || "<control>";
    const value = args.value     || "0";
    return {
      description: `Set ${comp}.${ctrl} = ${value}`,
      messages: [{
        role: "user",
        content: {
          type: "text",
          text:
            `Find the component "${comp}" in the Q-SYS design, inspect its "${ctrl}" control, ` +
            `then set its value to ${value}. Confirm the change by reading the value back.`,
        },
      }],
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
});

// =============================================================================
// Utilities
// =============================================================================
function fmt(obj) { return JSON.stringify(obj, null, 2); }
function stderr(msg) { process.stderr.write(msg + "\n"); }

// =============================================================================
// Bootstrap
// =============================================================================
async function main() {
  stderr(`[bridge] Q-SYS MCP Server starting  (target: ${QSYS_HOST}:${QSYS_PORT})`);

  // Best-effort initial connection (Claude can still be used; we'll reconnect on demand)
  connectToQSYS().catch(e => {
    stderr(`[bridge] Initial connect failed: ${e.message} — will retry`);
    scheduleReconnect();
  });

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  stderr("[bridge] MCP transport ready — Claude Desktop can now connect");
}

main().catch(e => {
  process.stderr.write(`[bridge] FATAL: ${e.message}\n`);
  process.exit(1);
});
