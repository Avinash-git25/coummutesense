/**
 * CommuteIQ — storage.
 *
 * A tiny document store over `node:sqlite` (built into Node 22.5+, so there is
 * nothing to install and nothing to keep running).
 *
 * ── Why not MongoDB, as the TRD specifies? ─────────────────────────────────
 * Neither `mongod` nor Docker is installed on the demo machine, and a database
 * that fails to start takes the whole demo with it. So rows are stored
 * DOCUMENT-SHAPED — `_id` TEXT PRIMARY KEY plus a `doc` JSON column — and the
 * collection API below mirrors the handful of Mongo operations we actually use.
 * The TRD's `routes` / `telematics_logs` schemas are stored verbatim, so
 * swapping in a real Mongo driver later means reimplementing this one file.
 *
 * The database is in-memory on purpose: every boot re-seeds from
 * `data/seed/*.json`, so the demo starts from an identical, known state every
 * single time and no stale state can survive a restart mid-presentation.
 */

import { DatabaseSync } from 'node:sqlite';

export const COLLECTIONS = [
  'routes',
  'stops',
  'vehicles',
  'drivers',
  'telematics_current',
  'crowd_observations',
  'passes',
  'alerts',
  'reroutes',
];

/** A Mongo-flavoured view over one `(_id, doc)` table. */
class Collection {
  /** @param {DatabaseSync} db @param {string} name */
  constructor(db, name) {
    this.name = name;
    this.$insert = db.prepare(`INSERT OR REPLACE INTO ${name} (_id, doc) VALUES (?, ?)`);
    this.$get = db.prepare(`SELECT doc FROM ${name} WHERE _id = ?`);
    this.$all = db.prepare(`SELECT doc FROM ${name}`);
    this.$delete = db.prepare(`DELETE FROM ${name} WHERE _id = ?`);
    this.$clear = db.prepare(`DELETE FROM ${name}`);
    this.$count = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`);
  }

  /**
   * Insert or replace. Requires `_id`.
   * @template T @param {T & {_id:string}} doc @returns {T}
   */
  put(doc) {
    if (!doc || typeof doc._id !== 'string' || doc._id === '') {
      throw new TypeError(`${this.name}.put requires a non-empty string _id`);
    }
    this.$insert.run(doc._id, JSON.stringify(doc));
    return doc;
  }

  /** @param {Array<object>} docs */
  putMany(docs) {
    for (const d of docs) this.put(d);
    return docs.length;
  }

  /** @param {string} id @returns {object|null} */
  get(id) {
    const row = this.$get.get(id);
    return row ? JSON.parse(row.doc) : null;
  }

  /** @returns {object[]} */
  all() {
    return this.$all.all().map((r) => JSON.parse(r.doc));
  }

  /** @param {(doc:object)=>boolean} predicate @returns {object[]} */
  find(predicate) {
    return this.all().filter(predicate);
  }

  /** @param {(doc:object)=>boolean} predicate @returns {object|null} */
  findOne(predicate) {
    return this.all().find(predicate) ?? null;
  }

  /**
   * Shallow merge a patch into an existing doc.
   * @param {string} id @param {object} patch @returns {object|null} updated doc
   */
  update(id, patch) {
    const existing = this.get(id);
    if (!existing) return null;
    const next = { ...existing, ...patch, _id: id };
    this.put(next);
    return next;
  }

  /** @param {string} id @returns {boolean} whether a row was removed */
  remove(id) {
    return this.$delete.run(id).changes > 0;
  }

  clear() { this.$clear.run(); }

  get size() { return this.$count.get().n; }
}

/**
 * Bounded append-only log kept in memory rather than SQLite.
 *
 * The TRD names `telematics_logs` like a time series but models it as a single
 * document per vehicle. We split those concerns: live state lives in the
 * `telematics_current` collection, and this ring buffer backs the sparklines —
 * which never need to outlive the process, and must not grow without bound
 * while a demo idles.
 */
export class RingBuffer {
  #items;
  #capacity;
  #next = 0;
  #full = false;

  constructor(capacity = 120) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError('RingBuffer capacity must be a positive integer');
    }
    this.#capacity = capacity;
    this.#items = new Array(capacity);
  }

  push(item) {
    this.#items[this.#next] = item;
    this.#next = (this.#next + 1) % this.#capacity;
    if (this.#next === 0) this.#full = true;
    return item;
  }

  /** @returns {any[]} oldest-first */
  toArray() {
    if (!this.#full) return this.#items.slice(0, this.#next);
    return [...this.#items.slice(this.#next), ...this.#items.slice(0, this.#next)];
  }

  get length() { return this.#full ? this.#capacity : this.#next; }
  get capacity() { return this.#capacity; }
  clear() { this.#items = new Array(this.#capacity); this.#next = 0; this.#full = false; }
}

/**
 * Open the store and create every collection table.
 * @param {string} location  ':memory:' (default) or a file path
 */
export function openDb(location = ':memory:') {
  const db = new DatabaseSync(location);
  db.exec('PRAGMA journal_mode = MEMORY;');

  for (const name of COLLECTIONS) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (_id TEXT PRIMARY KEY, doc TEXT NOT NULL);`);
  }

  /** @type {Record<string, Collection>} */
  const collections = {};
  for (const name of COLLECTIONS) collections[name] = new Collection(db, name);

  return {
    raw: db,
    ...collections,
    /** Wipe every collection. Backs the demo's reset control. */
    clearAll() { for (const name of COLLECTIONS) collections[name].clear(); },
    close() { db.close(); },
  };
}

/** @typedef {ReturnType<typeof openDb>} Store */
