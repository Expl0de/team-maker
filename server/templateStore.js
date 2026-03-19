import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import stateStore from "./stateStore.js";

// Legacy path — used for one-time migration
const __dirname = dirname(fileURLToPath(import.meta.url));
const LEGACY_FILE = join(__dirname, "..", "data", "templates.json");

/**
 * Migrate templates from the old data/templates.json into StateStore.
 * Runs once on first load; after that, StateStore is the source of truth.
 */
export function migrateFromLegacy() {
  const existing = stateStore.get("templates");
  if (existing && existing.length > 0) return; // already migrated

  try {
    const raw = readFileSync(LEGACY_FILE, "utf-8");
    const templates = JSON.parse(raw);
    if (Array.isArray(templates) && templates.length > 0) {
      stateStore.set("templates", templates);
      console.log(`[TemplateStore] Migrated ${templates.length} template(s) from legacy file`);
    }
  } catch {
    // No legacy file or can't read — that's fine
  }
}

export function loadAll() {
  return stateStore.get("templates") || [];
}

export function get(id) {
  const templates = loadAll();
  return templates.find((t) => t.id === id) || null;
}

export function save({ name, roles }) {
  const templates = loadAll();
  const template = {
    id: uuidv4(),
    name,
    roles,
    createdAt: new Date().toISOString(),
  };
  templates.push(template);
  stateStore.set("templates", templates);
  return template;
}

export function remove(id) {
  const templates = loadAll();
  const idx = templates.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  templates.splice(idx, 1);
  stateStore.set("templates", templates);
  return true;
}
