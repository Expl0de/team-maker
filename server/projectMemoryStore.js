import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const TEAM_MAKER_DIR = ".team-maker";
const MEMORY_FILE = "project-memory.json";
const GITIGNORE_MARKER = "# Team Maker: ignore session artifact dirs";
const GITIGNORE_ENTRY = ".team-maker/*/";
const GITIGNORE_BLOCK = `\n${GITIGNORE_MARKER}\n${GITIGNORE_ENTRY}\n`;

/**
 * Stores project-level memory in <cwd>/.team-maker/project-memory.json.
 * Not a singleton — instantiated per cwd.
 */
export class ProjectMemoryStore {
  constructor(cwd) {
    this.cwd = cwd;
    this.dir = join(cwd, TEAM_MAKER_DIR);
    this.memoryPath = join(this.dir, MEMORY_FILE);
  }

  ensureGitignore() {
    mkdirSync(this.dir, { recursive: true });
    const rootGitignorePath = join(this.cwd, ".gitignore");
    const existing = existsSync(rootGitignorePath)
      ? readFileSync(rootGitignorePath, "utf8")
      : "";
    if (!existing.includes(GITIGNORE_ENTRY)) {
      const suffix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
      writeFileSync(rootGitignorePath, existing + suffix + GITIGNORE_BLOCK, "utf8");
    }
  }

  _read() {
    if (!existsSync(this.memoryPath)) return {};
    try {
      return JSON.parse(readFileSync(this.memoryPath, "utf8"));
    } catch {
      return {};
    }
  }

  _write(data) {
    this.ensureGitignore();
    writeFileSync(this.memoryPath, JSON.stringify(data, null, 2), "utf8");
  }

  /**
   * Upsert a memory entry.
   * @param {string} key
   * @param {string} content
   * @param {string} [summary]
   * @param {string} [agentLabel] - e.g. "Architect (20260315-120000)"
   */
  store(key, content, summary, agentLabel) {
    const data = this._read();
    data[key] = {
      content,
      summary: summary || "",
      storedBy: agentLabel || "unknown",
      lastUpdated: new Date().toISOString(),
      tags: [],
      deprecated: false,
    };
    this._write(data);
    return data[key];
  }

  /**
   * Soft-mark an entry as stale. Excluded from snapshot() but still searchable.
   * @param {string} key
   * @param {string} [reason]
   */
  deprecate(key, reason) {
    const data = this._read();
    if (!data[key]) return null;
    data[key].deprecated = true;
    data[key].deprecatedReason = reason || "";
    data[key].deprecatedAt = new Date().toISOString();
    this._write(data);
    return data[key];
  }

  /**
   * Retrieve a single entry by key.
   */
  get(key) {
    const data = this._read();
    return data[key] || null;
  }

  /**
   * Return all entries as lightweight descriptors (no full content).
   */
  list() {
    const data = this._read();
    return Object.entries(data).map(([key, entry]) => ({
      key,
      summary: entry.summary,
      storedBy: entry.storedBy,
      lastUpdated: entry.lastUpdated,
      tags: entry.tags,
      deprecated: entry.deprecated || false,
      deprecatedReason: entry.deprecatedReason || "",
    }));
  }

  /**
   * Keyword search across keys, summaries, and content.
   */
  query(searchTerms) {
    const data = this._read();
    const terms = searchTerms.toLowerCase().split(/\s+/).filter(Boolean);
    const results = [];
    for (const [key, entry] of Object.entries(data)) {
      const haystack = `${key} ${entry.summary} ${entry.content}`.toLowerCase();
      const score = terms.filter((t) => haystack.includes(t)).length;
      if (score > 0) {
        results.push({ key, score, ...entry, deprecated: entry.deprecated || false });
      }
    }
    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Returns a condensed bullet-point summary for prompt injection.
   * Only keys + summaries — no full content.
   */
  snapshot() {
    const entries = this.list().filter((e) => !e.deprecated);
    if (entries.length === 0) return null;
    return entries.map((e) => `- ${e.key}: ${e.summary || "(no summary)"}`).join("\n");
  }
}
