// Context retention: bounded in-memory history with optional disk persistence.
import fs from "node:fs";
import path from "node:path";

export class IncidentStore {
  constructor(max = 200, dataDir = undefined) {
    this.max = max;
    this.dataDir = dataDir;
    this.records = new Map();
    this.order = [];
  }

  file() { return this.dataDir ? path.join(this.dataDir, "incidents.json") : undefined; }

  load() {
    const file = this.file();
    if (!file) return;
    try {
      const arr = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const record of arr.slice(-this.max)) { this.records.set(record.incident.id, record); this.order.push(record.incident.id); }
    } catch { /* no prior context */ }
  }

  persist() {
    const file = this.file();
    if (!file) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.order.map(id => this.records.get(id)).filter(Boolean), null, 2));
      this.lastPersistError = undefined;
    } catch (e) {
      // Best-effort by design (memory is the source of truth), but a mounted
      // DATA_DIR owned by another uid is a real misconfiguration: it silently
      // loses context across restarts. Report it once per distinct error.
      this.lastPersistError = { code: e.code, message: e.message, at: new Date().toISOString() };
      if (this.lastReportedError !== e.code) {
        this.lastReportedError = e.code;
        console.log(JSON.stringify({
          level: "error", event: "state_persist_failed", service: "agent-core",
          timestamp: new Date().toISOString(), dataDir: this.dataDir, code: e.code || "EUNKNOWN",
          hint: e.code === "EACCES" || e.code === "EPERM" || e.code === "EROFS"
            ? `DATA_DIR '${this.dataDir}' is not writable by uid ${typeof process.getuid === "function" ? process.getuid() : "?"}; context will not survive a restart. Fix: chown -R node:node ${this.dataDir}`
            : e.message
        }));
      }
    }
  }

  create(incident) {
    const now = new Date().toISOString();
    const record = { incident, status: "investigating", createdAt: now, updatedAt: now };
    this.records.set(incident.id, record);
    this.order.push(incident.id);
    while (this.order.length > this.max) this.records.delete(this.order.shift());
    this.persist();
    return record;
  }

  // `status` is optional so the existing "analyzed" behaviour is unchanged; the
  // batch gate passes "skipped" for incidents Liquid judged ordinary.
  attachAnalysis(id, analysis, status = "analyzed") {
    const r = this.records.get(id);
    if (!r) return undefined;
    r.analysis = analysis; r.status = status; r.updatedAt = new Date().toISOString();
    this.persist();
    return r;
  }

  /** Shallow-merge extra top-level fields onto a record (e.g. `batchId`). */
  annotate(id, fields = {}) {
    const r = this.records.get(id);
    if (!r) return undefined;
    Object.assign(r, fields);
    r.updatedAt = new Date().toISOString();
    this.persist();
    return r;
  }

  setNotification(id, notification) {
    const r = this.records.get(id);
    if (!r) return;
    r.notification = notification; r.updatedAt = new Date().toISOString();
    this.persist();
  }

  setFeedback(id, status, note) {
    const r = this.records.get(id);
    if (!r) return undefined;
    r.feedback = { status, note, at: new Date().toISOString() };
    r.status = status; r.updatedAt = new Date().toISOString();
    this.persist();
    return r;
  }

  get(id) { return this.records.get(id); }
  list(limit = 50) { return this.order.slice(-limit).reverse().map(id => this.records.get(id)).filter(Boolean); }

  recurrenceForPath(p, excludeId) {
    let count = 0;
    for (const r of this.records.values()) if (r.incident.path === p && r.incident.id !== excludeId) count++;
    return count;
  }

  contextSummary() {
    const records = [...this.records.values()];
    const byStatus = {}, byPath = {};
    for (const r of records) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      byPath[r.incident.path] = (byPath[r.incident.path] || 0) + 1;
    }
    const recurring = Object.entries(byPath).filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).map(([p, n]) => ({ path: p, count: n }));
    return { total: records.length, byStatus, recurring, escalated: records.filter(r => r.analysis?.escalate).length };
  }
}
