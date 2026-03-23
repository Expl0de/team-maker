import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const STATE_DIR = join(homedir(), ".team-maker");
const STATE_FILE = join(STATE_DIR, "state.json");
const DEBOUNCE_MS = 500;

const DEFAULT_STATE = {
  version: 1,
  teams: {},
  messages: {},
  tasks: {},
  contexts: {},
  files: {},
  templates: [],
  settings: {},
};

class StateStore {
  constructor() {
    this._state = null;
    this._saveTimer = null;
    this._listeners = [];
  }

  load() {
    mkdirSync(STATE_DIR, { recursive: true });

    if (!existsSync(STATE_FILE)) {
      this._state = structuredClone(DEFAULT_STATE);
      this._writeSync();
      console.log(`[StateStore] Created new state file at ${STATE_FILE}`);
      return this._state;
    }

    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      this._state = JSON.parse(raw);

      // Ensure all expected top-level keys exist (forward-compat)
      for (const key of Object.keys(DEFAULT_STATE)) {
        if (!(key in this._state)) {
          this._state[key] = structuredClone(DEFAULT_STATE[key]);
        }
      }

      console.log(`[StateStore] Loaded state from ${STATE_FILE}`);
    } catch (err) {
      console.warn(`[StateStore] Corrupted state file, backing up and starting fresh: ${err.message}`);
      try {
        const backupPath = STATE_FILE + `.backup-${Date.now()}`;
        copyFileSync(STATE_FILE, backupPath);
        console.warn(`[StateStore] Backup saved to ${backupPath}`);
      } catch {}
      this._state = structuredClone(DEFAULT_STATE);
      this._writeSync();
    }

    return this._state;
  }

  get(path) {
    if (!this._state) this.load();
    const parts = path.split(".");
    let current = this._state;
    for (const part of parts) {
      if (current == null || typeof current !== "object") return undefined;
      current = current[part];
    }
    return current;
  }

  set(path, value) {
    if (!this._state) this.load();
    const parts = path.split(".");
    let current = this._state;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] == null || typeof current[parts[i]] !== "object") {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
    this._scheduleSave();
    this._notify(path, value);
  }

  delete(path) {
    if (!this._state) this.load();
    const parts = path.split(".");
    let current = this._state;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] == null || typeof current[parts[i]] !== "object") return;
      current = current[parts[i]];
    }
    delete current[parts[parts.length - 1]];
    this._scheduleSave();
    this._notify(path, undefined);
  }

  onUpdate(callback) {
    this._listeners.push(callback);
  }

  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._writeSync();
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._writeSync();
    }, DEBOUNCE_MS);
  }

  _writeSync() {
    try {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(STATE_FILE, JSON.stringify(this._state, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error(`[StateStore] Failed to write state: ${err.message}`);
    }
  }

  _notify(path, value) {
    for (const cb of this._listeners) {
      try {
        cb(path, value);
      } catch {}
    }
  }
}

export default new StateStore();
