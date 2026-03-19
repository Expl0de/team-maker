import { randomUUID } from "crypto";
import stateStore from "./stateStore.js";

class MessageQueue {
  constructor() {
    // In-memory index: agentId -> message array
    this._queues = new Map();
    // All messages by ID for quick lookup
    this._messages = new Map();
    // Listeners for new message events (for WebSocket broadcast)
    this._listeners = [];
  }

  /**
   * Restore persisted messages from StateStore on startup.
   */
  restoreFromState() {
    const persisted = stateStore.get("messages") || {};
    let count = 0;
    for (const [id, msg] of Object.entries(persisted)) {
      this._messages.set(id, msg);
      // Index into recipient's queue
      if (!this._queues.has(msg.to)) {
        this._queues.set(msg.to, []);
      }
      this._queues.get(msg.to).push(msg);
      count++;
    }
    if (count > 0) {
      console.log(`[MessageQueue] Restored ${count} message(s) from state`);
    }
  }

  /**
   * Enqueue a message from one agent to another.
   * Returns the created message object.
   */
  enqueue(from, to, content, { fromName, toName, teamId } = {}) {
    const msg = {
      id: randomUUID(),
      from,
      to,
      fromName: fromName || from,
      toName: toName || to,
      teamId: teamId || null,
      content,
      timestamp: new Date().toISOString(),
      read: false,
    };

    this._messages.set(msg.id, msg);

    if (!this._queues.has(to)) {
      this._queues.set(to, []);
    }
    this._queues.get(to).push(msg);

    // Persist
    stateStore.set(`messages.${msg.id}`, msg);

    // Notify listeners
    for (const cb of this._listeners) {
      try {
        cb(msg);
      } catch {}
    }

    return msg;
  }

  /**
   * Get all unread messages for an agent.
   */
  getUnread(agentId) {
    const queue = this._queues.get(agentId) || [];
    return queue.filter((m) => !m.read);
  }

  /**
   * Mark a specific message as read.
   */
  markRead(messageId) {
    const msg = this._messages.get(messageId);
    if (!msg) return false;
    msg.read = true;
    stateStore.set(`messages.${messageId}.read`, true);
    return true;
  }

  /**
   * Mark all unread messages for an agent as read.
   * Returns the number of messages marked.
   */
  markAllRead(agentId) {
    const unread = this.getUnread(agentId);
    for (const msg of unread) {
      msg.read = true;
      stateStore.set(`messages.${msg.id}.read`, true);
    }
    return unread.length;
  }

  /**
   * Get full message history for an agent (both sent and received).
   */
  getHistory(agentId) {
    const all = Array.from(this._messages.values());
    return all
      .filter((m) => m.from === agentId || m.to === agentId)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  /**
   * Get all messages for a team.
   */
  getTeamMessages(teamId) {
    const all = Array.from(this._messages.values());
    return all
      .filter((m) => m.teamId === teamId)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  }

  /**
   * Register a listener for new messages (for WebSocket broadcast).
   */
  onMessage(callback) {
    this._listeners.push(callback);
  }

  /**
   * Clean up messages for a destroyed team.
   */
  clearTeam(teamId) {
    const toRemove = [];
    for (const [id, msg] of this._messages) {
      if (msg.teamId === teamId) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this._messages.delete(id);
      stateStore.delete(`messages.${id}`);
    }
    // Rebuild queues (simpler than selective removal)
    this._queues.clear();
    for (const msg of this._messages.values()) {
      if (!this._queues.has(msg.to)) {
        this._queues.set(msg.to, []);
      }
      this._queues.get(msg.to).push(msg);
    }
  }
}

export default new MessageQueue();
