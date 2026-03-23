import { randomUUID } from "crypto";
import stateStore from "./stateStore.js";

/**
 * Task states: pending → assigned → in_progress → completed | failed
 *
 * Task schema:
 * {
 *   id, title, description, status,
 *   complexity,       // "low" | "medium" | "high" (for smart model routing)
 *   assignedTo,       // agentId (session ID)
 *   assignedToName,   // human-readable agent name
 *   dependsOn[],      // array of task IDs that must be completed first
 *   result,           // completion summary (set on complete)
 *   failReason,       // failure reason (set on fail)
 *   createdBy,        // agentId that created the task
 *   createdByName,    // human-readable name of creator
 *   teamId,
 *   createdAt,
 *   updatedAt,
 * }
 */

const VALID_STATUSES = ["pending", "assigned", "in_progress", "completed", "failed"];

class TaskBoard {
  constructor() {
    this._tasks = new Map(); // id -> task
    this._listeners = [];
  }

  /**
   * Restore persisted tasks from StateStore on startup.
   */
  restoreFromState() {
    const persisted = stateStore.get("tasks") || {};
    let count = 0;
    for (const [id, task] of Object.entries(persisted)) {
      this._tasks.set(id, task);
      count++;
    }
    if (count > 0) {
      console.log(`[TaskBoard] Restored ${count} task(s) from state`);
    }
  }

  /**
   * Create a new task on the board.
   */
  createTask({ title, description, complexity, dependsOn, createdBy, createdByName, teamId }) {
    const validComplexity = ["low", "medium", "high"];
    const task = {
      id: randomUUID(),
      title,
      description: description || "",
      status: "pending",
      complexity: validComplexity.includes(complexity) ? complexity : "medium",
      assignedTo: null,
      assignedToName: null,
      dependsOn: dependsOn || [],
      result: null,
      failReason: null,
      createdBy: createdBy || null,
      createdByName: createdByName || null,
      teamId: teamId || null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this._tasks.set(task.id, task);
    stateStore.set(`tasks.${task.id}`, task);
    this._emit("task-created", task);
    return task;
  }

  /**
   * Claim a pending task. Task must be pending and all dependencies completed.
   */
  claimTask(taskId, agentId, agentName) {
    const task = this._tasks.get(taskId);
    if (!task) return { error: "Task not found" };
    if (task.status !== "pending") return { error: `Task is ${task.status}, not pending` };

    // Check dependencies
    const unmet = this._unmetDependencies(task);
    if (unmet.length > 0) {
      const names = unmet.map((t) => `"${t.title}" (${t.status})`).join(", ");
      return { error: `Blocked by unfinished dependencies: ${names}` };
    }

    task.status = "assigned";
    task.assignedTo = agentId;
    task.assignedToName = agentName || agentId;
    task.updatedAt = new Date().toISOString();

    stateStore.set(`tasks.${taskId}`, task);
    this._emit("task-claimed", task);
    return { task };
  }

  /**
   * Mark a claimed/assigned task as in-progress.
   */
  startTask(taskId, agentId) {
    const task = this._tasks.get(taskId);
    if (!task) return { error: "Task not found" };
    if (task.status !== "assigned") return { error: `Task is ${task.status}, not assigned` };
    if (task.assignedTo !== agentId) return { error: "Task is assigned to a different agent" };

    task.status = "in_progress";
    task.updatedAt = new Date().toISOString();

    stateStore.set(`tasks.${taskId}`, task);
    this._emit("task-started", task);
    return { task };
  }

  /**
   * Complete a task with a result summary.
   */
  completeTask(taskId, agentId, result) {
    const task = this._tasks.get(taskId);
    if (!task) return { error: "Task not found" };
    if (task.status !== "assigned" && task.status !== "in_progress") {
      return { error: `Task is ${task.status}, cannot complete` };
    }
    if (task.assignedTo !== agentId) return { error: "Task is assigned to a different agent" };

    task.status = "completed";
    task.result = result || "";
    task.updatedAt = new Date().toISOString();

    stateStore.set(`tasks.${taskId}`, task);
    this._emit("task-completed", task);
    return { task };
  }

  /**
   * Fail a task with a reason. Allows reassignment.
   */
  failTask(taskId, agentId, reason) {
    const task = this._tasks.get(taskId);
    if (!task) return { error: "Task not found" };
    if (task.status !== "assigned" && task.status !== "in_progress") {
      return { error: `Task is ${task.status}, cannot fail` };
    }
    if (task.assignedTo !== agentId) return { error: "Task is assigned to a different agent" };

    task.status = "failed";
    task.failReason = reason || "";
    task.assignedTo = null;
    task.assignedToName = null;
    task.updatedAt = new Date().toISOString();

    stateStore.set(`tasks.${taskId}`, task);
    this._emit("task-failed", task);
    return { task };
  }

  /**
   * Reset a failed task back to pending so it can be reassigned.
   */
  retryTask(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return { error: "Task not found" };
    if (task.status !== "failed") return { error: `Task is ${task.status}, not failed` };

    task.status = "pending";
    task.failReason = null;
    task.assignedTo = null;
    task.assignedToName = null;
    task.updatedAt = new Date().toISOString();

    stateStore.set(`tasks.${taskId}`, task);
    this._emit("task-retried", task);
    return { task };
  }

  /**
   * Get a single task by ID.
   */
  getTask(taskId) {
    return this._tasks.get(taskId) || null;
  }

  /**
   * Get all tasks for a team, optionally filtered.
   */
  getTeamTasks(teamId, filter) {
    const tasks = Array.from(this._tasks.values()).filter((t) => t.teamId === teamId);

    if (filter) {
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        return tasks.filter((t) => statuses.includes(t.status));
      }
      if (filter.assignedTo) {
        return tasks.filter((t) => t.assignedTo === filter.assignedTo);
      }
    }

    return tasks.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  /**
   * Get board summary (counts by status).
   */
  getBoardSummary(teamId) {
    const tasks = this.getTeamTasks(teamId);
    const summary = { total: tasks.length, pending: 0, assigned: 0, in_progress: 0, completed: 0, failed: 0 };
    for (const t of tasks) {
      summary[t.status] = (summary[t.status] || 0) + 1;
    }
    return summary;
  }

  /**
   * Register a listener for task events.
   */
  onTaskEvent(callback) {
    this._listeners.push(callback);
  }

  /**
   * Clean up tasks for a destroyed team.
   */
  clearTeam(teamId) {
    const toRemove = [];
    for (const [id, task] of this._tasks) {
      if (task.teamId === teamId) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this._tasks.delete(id);
      stateStore.delete(`tasks.${id}`);
    }
  }

  /**
   * Get the recommended model for a task based on a routing table.
   * Returns the model string or null (use default).
   */
  getRecommendedModel(taskId, modelRouting) {
    const task = this._tasks.get(taskId);
    if (!task || !modelRouting) return null;
    return modelRouting[task.complexity] || null;
  }

  /**
   * Check unmet dependencies for a task.
   */
  _unmetDependencies(task) {
    const unmet = [];
    for (const depId of task.dependsOn) {
      const dep = this._tasks.get(depId);
      if (!dep || dep.status !== "completed") {
        unmet.push(dep || { id: depId, title: depId, status: "unknown" });
      }
    }
    return unmet;
  }

  _emit(event, task) {
    for (const cb of this._listeners) {
      try {
        cb(event, task);
      } catch {}
    }
  }
}

export default new TaskBoard();
