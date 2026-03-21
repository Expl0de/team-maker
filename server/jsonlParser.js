import { readFile } from "fs/promises";
import { watch } from "fs";

/**
 * JsonlParser — Incrementally parses Claude Code JSONL log files and extracts
 * structured agent events (tool calls, assistant messages, errors, completions).
 *
 * This is the structured control plane for AP3, replacing PTY-based state tracking.
 * PTY remains for display (xterm.js); JSONL becomes the source of truth for agent activity.
 *
 * JSONL entry types from Claude Code:
 *   - "assistant"  — assistant turn with content blocks (text, tool_use, thinking)
 *   - "user"       — user turn with content blocks (text, tool_result)
 *   - "progress"   — hook progress events (mostly internal, not useful for us)
 *   - "queue-operation" — internal queue ops
 *   - "file-history-snapshot" — file backup snapshots
 *   - "last-prompt" — session end marker
 */

/**
 * Parse a single JSONL entry and extract structured events.
 * Returns an array of events (may be empty or multiple per entry).
 */
function extractEvents(entry) {
  const events = [];

  if (entry.type === "assistant" && entry.message) {
    const msg = entry.message;
    const content = msg.content || [];
    const timestamp = entry.timestamp || new Date().toISOString();
    const model = msg.model || null;
    const stopReason = msg.stop_reason || null;

    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) {
        events.push({
          type: "assistant_message",
          text: block.text.trim(),
          model,
          timestamp,
        });
      }

      if (block.type === "tool_use") {
        events.push({
          type: "tool_call",
          toolName: block.name,
          toolUseId: block.id,
          input: summarizeToolInput(block.name, block.input),
          timestamp,
        });
      }

      if (block.type === "thinking" && block.thinking) {
        events.push({
          type: "thinking",
          length: block.thinking.length,
          timestamp,
        });
      }
    }

    // Emit completion event when the assistant turn ends
    if (stopReason === "end_turn") {
      events.push({
        type: "turn_complete",
        model,
        timestamp,
      });
    }

    // Extract usage for per-turn tracking
    if (msg.usage) {
      events.push({
        type: "usage",
        inputTokens: msg.usage.input_tokens || 0,
        outputTokens: msg.usage.output_tokens || 0,
        cacheRead: msg.usage.cache_read_input_tokens || 0,
        cacheWrite: msg.usage.cache_creation_input_tokens || 0,
        timestamp,
      });
    }
  }

  if (entry.type === "user" && entry.message) {
    const content = entry.message.content || [];
    const timestamp = entry.timestamp || new Date().toISOString();

    for (const block of content) {
      if (block.type === "tool_result") {
        const isError = block.is_error === true;
        events.push({
          type: "tool_result",
          toolUseId: block.tool_use_id,
          isError,
          // Don't include full content — can be huge (file contents, etc.)
          contentPreview: summarizeToolResult(block),
          timestamp,
        });
      }
    }
  }

  return events;
}

/**
 * Summarize tool input for display — avoid huge payloads in the event log.
 */
function summarizeToolInput(toolName, input) {
  if (!input) return {};

  switch (toolName) {
    case "Read":
      return { file_path: input.file_path, offset: input.offset, limit: input.limit };
    case "Edit":
      return {
        file_path: input.file_path,
        changeSize: (input.old_string?.length || 0) + (input.new_string?.length || 0),
      };
    case "Write":
      return { file_path: input.file_path, contentLength: input.content?.length || 0 };
    case "Bash":
      return { command: input.command?.slice(0, 200) };
    case "Grep":
      return { pattern: input.pattern, path: input.path, type: input.type };
    case "Glob":
      return { pattern: input.pattern, path: input.path };
    case "Agent":
      return { description: input.description, subagent_type: input.subagent_type };
    default:
      // For MCP tools and others, include keys but truncate values
      const summary = {};
      for (const [key, val] of Object.entries(input)) {
        if (typeof val === "string" && val.length > 100) {
          summary[key] = val.slice(0, 100) + "...";
        } else {
          summary[key] = val;
        }
      }
      return summary;
  }
}

/**
 * Summarize tool result content for display.
 */
function summarizeToolResult(block) {
  const content = block.content;
  if (!content) return "(empty)";

  if (typeof content === "string") {
    return content.length > 200 ? content.slice(0, 200) + "..." : content;
  }

  if (Array.isArray(content)) {
    // tool_result content is an array of {type, text} blocks
    const texts = content
      .filter((c) => c.type === "text")
      .map((c) => c.text || "");
    const joined = texts.join("\n");
    return joined.length > 200 ? joined.slice(0, 200) + "..." : joined;
  }

  return "(complex)";
}

/**
 * JsonlWatcher — Watches a JSONL file for changes and emits parsed events incrementally.
 * Only reads new lines appended since the last read.
 */
class JsonlWatcher {
  constructor(filePath, onEvent) {
    this.filePath = filePath;
    this.onEvent = onEvent;
    this._bytesRead = 0;
    this._watcher = null;
    this._reading = false;
    this._pollTimer = null;
  }

  /**
   * Start watching the JSONL file. Does an initial read of any existing content,
   * then watches for appends.
   */
  start() {
    // Initial read
    this._readNewLines();

    // Watch for changes — fs.watch is more efficient than polling but can be unreliable
    // on some platforms, so we also poll as a fallback
    try {
      this._watcher = watch(this.filePath, { persistent: false }, (eventType) => {
        if (eventType === "change") {
          this._readNewLines();
        }
      });
      this._watcher.on("error", () => {
        // File might not exist yet — that's OK, we'll retry via poll
      });
    } catch {
      // File doesn't exist yet — will be picked up by polling
    }

    // Poll every 3 seconds as a fallback (more frequent than the old 5s usage polling)
    this._pollTimer = setInterval(() => this._readNewLines(), 3000);
  }

  stop() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _readNewLines() {
    if (this._reading) return; // Prevent concurrent reads
    this._reading = true;

    try {
      const content = await readFile(this.filePath, "utf-8");
      if (content.length <= this._bytesRead) {
        this._reading = false;
        return;
      }

      const newContent = content.slice(this._bytesRead);
      this._bytesRead = content.length;

      const lines = newContent.split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }

        const events = extractEvents(entry);
        for (const event of events) {
          try {
            this.onEvent(event);
          } catch (err) {
            console.error("[JsonlWatcher] Error in event handler:", err);
          }
        }
      }
    } catch {
      // File doesn't exist yet or read error — silently ignore
    }

    this._reading = false;
  }
}

export { JsonlWatcher, extractEvents };
