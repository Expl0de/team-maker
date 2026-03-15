import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const TEMPLATES_FILE = join(DATA_DIR, "templates.json");

function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function readTemplates() {
  try {
    return JSON.parse(readFileSync(TEMPLATES_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeTemplates(templates) {
  ensureDataDir();
  writeFileSync(TEMPLATES_FILE, JSON.stringify(templates, null, 2));
}

export function loadAll() {
  return readTemplates();
}

export function get(id) {
  return readTemplates().find((t) => t.id === id) || null;
}

export function save({ name, roles }) {
  const templates = readTemplates();
  const template = {
    id: uuidv4(),
    name,
    roles,
    createdAt: new Date().toISOString(),
  };
  templates.push(template);
  writeTemplates(templates);
  return template;
}

export function remove(id) {
  const templates = readTemplates();
  const idx = templates.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  templates.splice(idx, 1);
  writeTemplates(templates);
  return true;
}
