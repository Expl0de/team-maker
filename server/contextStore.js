import stateStore from "./stateStore.js";

const MAX_TOTAL_BYTES = 500 * 1024; // 500KB total content cap
const MAX_ENTRIES = 200;

// P1-23: Better token estimation — code averages ~3.3 chars/token, prose ~4.5
function estimateTokens(text) {
  if (!text) return 0;
  // Heuristic: count code-like indicators (braces, semicolons, indentation)
  const codeSignals = (text.match(/[{}();=<>]/g) || []).length;
  const codeRatio = codeSignals / Math.max(text.length, 1);
  // Blend between code (~3.3) and prose (~4.5) based on code density
  const charsPerToken = codeRatio > 0.03 ? 3.3 : 4.5;
  return Math.ceil(text.length / charsPerToken);
}

class ContextStore {
  constructor() {
    // key -> { key, content, summary, storedBy, storedByName, teamId, tokens, lastUpdated, accessCount }
    this._entries = new Map();
    this._listeners = [];
  }

  restoreFromState() {
    const saved = stateStore.get("contexts") || {};
    for (const [key, entry] of Object.entries(saved)) {
      this._entries.set(key, entry);
    }
    console.log(`[ContextStore] Restored ${this._entries.size} context entries`);
  }

  _persist() {
    const obj = {};
    for (const [key, entry] of this._entries) {
      obj[key] = entry;
    }
    stateStore.set("contexts", obj);
  }

  _totalBytes() {
    let total = 0;
    for (const entry of this._entries.values()) {
      total += (entry.content || "").length;
    }
    return total;
  }

  _evictLRU() {
    // P1-9: Only evict when actually over budget (skip linear scan otherwise)
    if (this._entries.size <= MAX_ENTRIES && this._totalBytes() <= MAX_TOTAL_BYTES) return;

    // Build sorted list once, then evict from oldest
    const sorted = Array.from(this._entries.entries())
      .sort((a, b) => new Date(a[1].lastUpdated).getTime() - new Date(b[1].lastUpdated).getTime());

    let idx = 0;
    while ((this._totalBytes() > MAX_TOTAL_BYTES || this._entries.size > MAX_ENTRIES) && idx < sorted.length) {
      this._entries.delete(sorted[idx][0]);
      idx++;
    }
  }

  /**
   * Store a context entry. If key exists, update it.
   */
  store(key, content, summary, { storedBy, storedByName, teamId } = {}) {
    const existing = this._entries.get(key);
    const entry = {
      key,
      content,
      summary: summary || "",
      storedBy: storedBy || null,
      storedByName: storedByName || null,
      teamId: teamId || null,
      tokens: estimateTokens(content), // P1-23: improved estimate
      lastUpdated: new Date().toISOString(),
      accessCount: existing ? existing.accessCount : 0,
    };
    this._entries.set(key, entry);
    this._evictLRU();
    this._persist();
    this._notify("stored", entry);
    return entry;
  }

  /**
   * Query context entries by keyword match against keys and summaries.
   * Returns top-N results sorted by relevance.
   */
  query(query, { teamId, limit = 10 } = {}) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const results = [];
    for (const entry of this._entries.values()) {
      if (teamId && entry.teamId !== teamId) continue;

      const haystack = `${entry.key} ${entry.summary}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score++;
      }
      if (score > 0) {
        // Bump access count
        entry.accessCount++;
        entry.lastUpdated = new Date().toISOString();
        results.push({ ...entry, score });
      }
    }

    results.sort((a, b) => b.score - a.score || b.accessCount - a.accessCount);

    if (results.length > 0) {
      this._persist(); // save updated accessCount/lastUpdated
    }

    return results.slice(0, limit);
  }

  /**
   * List all context entries (keys + summaries only, no full content).
   */
  list({ teamId } = {}) {
    const entries = [];
    for (const entry of this._entries.values()) {
      if (teamId && entry.teamId !== teamId) continue;
      entries.push({
        key: entry.key,
        summary: entry.summary,
        storedByName: entry.storedByName,
        tokens: entry.tokens,
        accessCount: entry.accessCount,
        lastUpdated: entry.lastUpdated,
      });
    }
    entries.sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));
    return entries;
  }

  /**
   * Get a single entry by key (full content).
   */
  get(key) {
    const entry = this._entries.get(key);
    if (entry) {
      entry.accessCount++;
      entry.lastUpdated = new Date().toISOString();
      this._persist();
    }
    return entry || null;
  }

  /**
   * Remove an entry by key.
   */
  invalidate(key) {
    const deleted = this._entries.delete(key);
    if (deleted) {
      this._persist();
      this._notify("invalidated", { key });
    }
    return deleted;
  }

  /**
   * Clear all entries for a team.
   */
  clearTeam(teamId) {
    let count = 0;
    for (const [key, entry] of this._entries) {
      if (entry.teamId === teamId) {
        this._entries.delete(key);
        count++;
      }
    }
    if (count > 0) this._persist();
    return count;
  }

  /**
   * Get stats about the context store.
   */
  getStats(teamId) {
    let totalEntries = 0;
    let totalBytes = 0;
    for (const entry of this._entries.values()) {
      if (teamId && entry.teamId !== teamId) continue;
      totalEntries++;
      totalBytes += (entry.content || "").length;
    }
    return {
      totalEntries,
      totalBytes,
      maxBytes: MAX_TOTAL_BYTES,
      usagePercent: Math.round((totalBytes / MAX_TOTAL_BYTES) * 100),
    };
  }

  onContextEvent(callback) {
    this._listeners.push(callback);
  }

  _notify(event, data) {
    for (const cb of this._listeners) {
      try {
        cb(event, data);
      } catch {}
    }
  }
}

export default new ContextStore();
