# Q-SYS ↔ Claude Desktop — MCP Bridge

Bidirectional integration between **QSC Q-SYS Designer** and **Anthropic Claude Desktop**
using the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

```
Claude Desktop  ←── stdio / MCP ──→  [Node.js bridge]  ←── TCP / JSON-RPC ──→  Q-SYS Plugin
```

Claude can **read every component and control** in your design and **write values** to controls
in real time — all via natural language conversation.

---

## Repository structure

```
qsys-claude-mcp/
├── qsys-claude-mcp-bridge.qplug   ← Install this in Q-SYS Designer
└── mcp-server/
    ├── index.js                    ← Claude Desktop bridge process
    └── package.json
```

---

## Part 1 — Q-SYS Plugin installation

### Requirements
- Q-SYS Designer **9.x** or later (or any version with Lua `TcpSocket` support)
- The plugin must run on a **Core or in the Emulator**

### Steps

1. Copy `qsys-claude-mcp-bridge.qplug` into your Q-SYS plugins folder:

   | OS      | Path |
   |---------|------|
   | Windows | `%USERPROFILE%\Documents\QSC\Q-SYS Designer\Plugins\` |
   | macOS   | `~/Documents/QSC/Q-SYS Designer/Plugins/` |

2. Open Q-SYS Designer and open (or create) a design.

3. In the **Component Library**, search for **"Claude MCP Bridge"** and drag it onto the schematic.

4. Configure properties (right-click the component → Properties):

   | Property | Default | Notes |
   |----------|---------|-------|
   | TCP Port | `8765`  | Must match `QSYS_PORT` in bridge env |
   | Max Clients | `4` | How many simultaneous MCP connections |
   | Heartbeat Interval | `30` | Seconds between keep-alive pings |
   | Allow Control Writes | `true` | Set to `false` for read-only / safe-mode |

5. Push the design to the Core / start the Emulator.  
   The plugin's status light should turn **green** with the message  
   `Listening on 0.0.0.0:8765`.

> **Firewall note:** If Claude Desktop and Q-SYS are on different machines, ensure  
> TCP port 8765 is open. For local development both run on `127.0.0.1`.

---

## Part 2 — MCP Server setup

### Requirements
- **Node.js ≥ 18**

### Install

```bash
cd mcp-server
npm install
```

### Test manually

```bash
QSYS_HOST=127.0.0.1 QSYS_PORT=8765 node index.js
```

You should see:
```
[bridge] Q-SYS MCP Server starting  (target: 127.0.0.1:8765)
[bridge] Connected to Q-SYS plugin at 127.0.0.1:8765
[bridge] MCP transport ready — Claude Desktop can now connect
```

---

## Part 3 — Claude Desktop configuration

Edit Claude Desktop's MCP config file:

| OS      | Path |
|---------|------|
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Add the following entry (adjust the path to your `index.js`):

```json
{
  "mcpServers": {
    "qsys-designer": {
      "command": "node",
      "args": ["/absolute/path/to/qsys-claude-mcp/mcp-server/index.js"],
      "env": {
        "QSYS_HOST": "127.0.0.1",
        "QSYS_PORT": "8765"
      }
    }
  }
}
```

Restart Claude Desktop. You should see **"qsys-designer"** appear in the MCP tools panel.

---

## Available MCP Tools

| Tool | Description |
|------|-------------|
| `ping_qsys` | Verify connectivity to the Q-SYS plugin |
| `get_design_info` | Design name, platform, emulation state |
| `list_components` | All named components with type |
| `find_components` | Filter components by partial name and/or type |
| `get_component` | Full control list for a single component |
| `get_control_value` | Read one control's value, string, min, max |
| `set_control_value` | Write a numeric, string, or boolean value |
| `set_multiple_controls` | Write several controls in one round-trip |

### MCP Prompts (built-in)

| Prompt | What it does |
|--------|--------------|
| `review_design` | Full design inventory + improvement suggestions |
| `audit_levels` | Finds all gain/mixer components and reports their levels |
| `find_and_set` | Guided component lookup and control write |

---

## Example conversations with Claude

**Explore the design:**
> "List all components in the Q-SYS design and tell me what they do."

**Read a level:**
> "What is the current gain value on the component called 'Room A Gain'?"

**Change a level:**
> "Set the gain on 'Room A Gain' to -6 dB."

**Bulk change:**
> "Mute all mixer output channels on the component named 'Main Mixer'."

**Design review:**
> "Review my Q-SYS design and flag any components with unusual naming or suspicious control values."

**Audit:**
> "Audit all level controls and tell me which ones are muted or at minimum."

---

## TCP Protocol (JSON-RPC 2.0 over newline-delimited TCP)

If you want to connect a custom client directly to the plugin:

### Request format
```json
{ "id": 1, "method": "control.setValue", "params": { "component": "My Gain", "control": "gain", "value": -10 } }
```
*(followed by `\n`)*

### Response format
```json
{ "id": 1, "result": { "success": true } }
```

### Available methods

| Method | Params | Returns |
|--------|--------|---------|
| `ping` | — | `{ pong, timestamp, designName }` |
| `design.getInfo` | — | `{ name, isEmulating, platform }` |
| `design.listComponents` | — | `{ components: [{name,type,properties}] }` |
| `design.findComponents` | `query?, type?` | `{ components }` |
| `component.getDetails` | `name` | `{ name, type, controls: [{name,value,string,...}] }` |
| `control.getValue` | `component, control` | `{ value, string, min, max, isDisabled }` |
| `control.setValue` | `component, control, value, valueType?` | `{ success }` |
| `control.setMultiple` | `controls[]` | `{ results[] }` |

### Server push events
The plugin broadcasts these unsolicited:
- `{ event:"connected", version, designName, writesAllowed }` — on new TCP connection
- `{ event:"heartbeat", timestamp, designName, isEmulating }` — every N seconds

---

## Security considerations

- The plugin only listens on `0.0.0.0` — bind to `127.0.0.1` by changing the Lua  
  `server:Listen(port)` call to `server:Listen(port, "127.0.0.1")` if your version supports it.
- Set **Allow Control Writes = false** in plugin properties for read-only / observer mode.
- Use a firewall rule to restrict port 8765 to trusted hosts only.

---

## Troubleshooting

| Symptom | Solution |
|---------|----------|
| Plugin status = red "Failed to listen" | Port already in use — change TCP Port property |
| Bridge can't connect | Check Core/Emulator is running and port matches |
| "Method not found" | Verify plugin version matches server version |
| Controls silently not changing | Check "Allow Control Writes" property is enabled |
| Claude Desktop doesn't show the tool | Restart Claude Desktop after editing config JSON |

---

## License

MIT — free to modify and redistribute.
