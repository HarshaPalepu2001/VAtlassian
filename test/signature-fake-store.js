/**
 * In-memory stand-in for Forge SQL that reproduces the two behaviours the
 * design depends on:
 *   1. PRIMARY KEY uniqueness raises a duplicate-key error.
 *   2. A single UPDATE ... WHERE <predicate> is atomic and reports affectedRows.
 *
 * It also injects an await between the read and the write of an append, which
 * is what makes the interleaving real: without it the JS event loop would run
 * each append to completion and the race would never occur.
 */
export class DuplicateKeyError extends Error {
  constructor(seq) { super(`duplicate key ${seq}`); this.code = 'ER_DUP_ENTRY'; }
}

export class FakeStore {
  constructor({ latency = 0 } = {}) {
    this.entries = new Map();   // seq -> row
    this.signatures = new Map();
    this.latency = latency;
    this.duplicateCollisions = 0;
  }

  async #tick() {
    // Forces a yield so concurrent callers interleave between read and write.
    await new Promise((r) => setTimeout(r, this.latency));
  }

  isDuplicateKey(err) { return err instanceof DuplicateKeyError || err?.code === 'ER_DUP_ENTRY'; }

  async readTail() {
    await this.#tick();
    if (this.entries.size === 0) return null;
    const maxSeq = Math.max(...this.entries.keys());
    return this.entries.get(maxSeq);
  }

  async insertEntry(row) {
    await this.#tick();
    if (this.entries.has(row.seq)) {
      this.duplicateCollisions += 1;
      throw new DuplicateKeyError(row.seq);
    }
    this.entries.set(row.seq, { ...row });
  }

  async entryAt(seq) {
    await this.#tick();
    const r = this.entries.get(seq);
    return r ? { ...r } : null;
  }

  async entryHashAt(seq) {
    const r = this.entries.get(seq);
    return r ? r.entry_hash : null;
  }

  async readRange(fromSeq, limit) {
    return [...this.entries.keys()]
      .filter((s) => s >= fromSeq)
      .sort((a, b) => a - b)
      .slice(0, limit)
      .map((s) => this.entries.get(s));
  }

  // --- signatures -----------------------------------------------------------
  putSignature(sig) { this.signatures.set(sig.approval_id, { ...sig }); }

  async casConsume({ approvalId, now, fromState, toState }) {
    await this.#tick();
    const s = this.signatures.get(approvalId);
    if (!s) return 0;
    // Mirrors: UPDATE ... SET state=? WHERE approval_id=? AND state=? AND expires_at>?
    if (s.state !== fromState || s.expires_at <= now) return 0;
    s.state = toState;
    s.consumed_at = now;
    return 1;
  }
}

/** Extends FakeStore with the interception surface, for handler tests. */
export class InterceptStore extends FakeStore {
  constructor(opts) {
    super(opts);
    this.items = new Map();
    this.changes = [];
    this.receipts = [];
    this.controlled = new Map();
    this.pendingSignatures = [];
    this._id = 0;
  }
  newId() { return `id-${++this._id}`; }
  setControlled(issueId, fields) { this.controlled.set(issueId, fields); }
  async controlledFieldsForIssue(issueId) { return this.controlled.get(issueId) ?? []; }
  async getItemState(issueId) { return this.items.get(issueId) ?? null; }
  async touchItemChecked(issueId, at) {
    const it = this.items.get(issueId); if (it) it.last_checked_at = at;
  }
  async upsertItemState(row) {
    this.items.set(row.issue_id, { version: 0, ...row });
  }
  async casItemState({ issueId, expectedVersion, next }) {
    const cur = this.items.get(issueId);
    if (!cur || cur.version !== expectedVersion) return 0;
    this.items.set(issueId, { ...cur, ...next, version: cur.version + 1 });
    return 1;
  }
  async insertContentChange(row) { this.changes.push(row); }
  async recordReceipt(r) { this.receipts.push(r); }
  async voidPendingSignatures({ issueId, contentHash }) {
    let n = 0;
    for (const s of this.pendingSignatures) {
      if (s.issue_id === issueId && s.state === 'PENDING' && s.covers_to_hash === contentHash) {
        s.state = 'VOID'; n++;
      }
    }
    return n;
  }
}
