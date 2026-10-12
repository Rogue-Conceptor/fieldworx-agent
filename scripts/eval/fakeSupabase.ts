/* eslint-disable @typescript-eslint/no-explicit-any */
// In-memory stand-in for the Supabase client, covering the query shapes that
// processInbound and the agent tools use. It is not Postgres: no RLS, no
// foreign keys, no triggers. The database rules it does enforce are the unique
// scheduled-slot index on appointments and, for sms_opt_status upserts, the
// table's check constraints (status, source, E.164 phone).

export type Row = Record<string, any>;
export type DbError = { message: string; code?: string };

export const TABLES = [
  "businesses",
  "customers",
  "service_locations",
  "leads",
  "conversations",
  "messages",
  "agent_runs",
  "appointments",
  "work_orders",
  "notifications",
  "audit_log",
  "sms_opt_status",
] as const;

// Tables with an updated_at column that a trigger maintains in the real schema.
const HAS_UPDATED_AT = new Set([
  "businesses",
  "customers",
  "service_locations",
  "leads",
  "conversations",
  "appointments",
  "work_orders",
  "sms_opt_status",
]);

const TIMESTAMPTZ_COLUMNS = ["starts_at", "ends_at", "scheduled_at"];
const ISO_LIKE = /^\d{4}-\d\d-\d\dT/;

// Postgres returns timestamptz as "2026-10-05T14:00:00+00:00".
function pgTimestamp(value: string): string {
  return new Date(value).toISOString().replace("Z", "+00:00").replace(".000", "");
}

// Timestamps compare by instant, everything else as-is.
function comparable(value: any): any {
  return typeof value === "string" && ISO_LIKE.test(value) ? Date.parse(value) : value;
}

function sameValue(a: any, b: any): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  return comparable(a) === comparable(b);
}

type Predicate = (row: Row) => boolean;

function predicateFor(op: string, col: string, raw: any): Predicate {
  switch (op) {
    case "eq":
      return (r) => sameValue(r[col], raw);
    case "neq":
      return (r) => !sameValue(r[col], raw);
    case "gt":
      return (r) => comparable(r[col]) > comparable(raw);
    case "gte":
      return (r) => comparable(r[col]) >= comparable(raw);
    case "lt":
      return (r) => comparable(r[col]) < comparable(raw);
    case "lte":
      return (r) => comparable(r[col]) <= comparable(raw);
    case "is":
      return (r) => sameValue(r[col], raw === "null" ? null : raw);
    default:
      throw new Error(`fakeSupabase: unsupported filter operator "${op}"`);
  }
}

// PostgREST or() syntax: "col.op.value,col.op.value".
function parseOr(expr: string): Predicate {
  const parts = predicatesFromOr(expr);
  return (r) => parts.some((p) => p(r));
}
function predicatesFromOr(expr: string): Predicate[] {
  return expr.split(",").map((term) => {
    const [col, op, ...rest] = term.split(".");
    return predicateFor(op, col, rest.join("."));
  });
}

export type WriteOp = "insert" | "update" | "delete" | "upsert";

// One insert/update/delete/upsert attempt: what was written and the error code
// (or message) if it failed.
export type WriteLogEntry = {
  table: string;
  op: WriteOp;
  payload: any;
  error: string | null;
};

export class FakeSupabase {
  tables: Record<string, Row[]> = Object.fromEntries(TABLES.map((t) => [t, [] as Row[]]));
  private lastTimestamp = 0;

  // ---- optional test hooks (the eval harness does not use any of these) ----

  // Every insert/update/delete attempt, in order, failed ones included.
  log: WriteLogEntry[] = [];
  private forcedFailures: { table: string; op: string; error: DbError }[] = [];
  private insertHooks = new Map<string, (input: Row) => void>();

  // The next `op` on `table` fails with `error` and changes nothing. A failed
  // "select" is not added to `log` (the log holds writes only).
  failNext(table: string, op: WriteOp | "select", error: DbError): void {
    this.forcedFailures.push({ table, op, error });
  }

  // Runs once, just before the next insert into `table` is built and checked:
  // a way to have another writer get in first.
  beforeNextInsert(table: string, hook: (input: Row) => void): void {
    this.insertHooks.set(table, hook);
  }

  takeForcedFailure(table: string, op: string): DbError | null {
    const i = this.forcedFailures.findIndex((f) => f.table === table && f.op === op);
    return i === -1 ? null : this.forcedFailures.splice(i, 1)[0].error;
  }

  takeInsertHook(table: string): ((input: Row) => void) | undefined {
    const hook = this.insertHooks.get(table);
    this.insertHooks.delete(table);
    return hook;
  }

  recordWrite(table: string, op: WriteOp, payload: any, error: DbError | null): void {
    this.log.push({
      table,
      op,
      payload: structuredClone(payload),
      error: error ? (error.code ?? error.message) : null,
    });
  }

  from(table: string): Query {
    if (!this.tables[table]) throw new Error(`fakeSupabase: unknown table "${table}"`);
    return new Query(this, table);
  }

  // Strictly increasing, so rows inserted within one millisecond still sort
  // in insertion order.
  nextTimestamp(): string {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return new Date(this.lastTimestamp).toISOString();
  }

  // A complete row: generated id and timestamps, then the table's defaults.
  build(table: string, input: Row): Row {
    const now = this.nextTimestamp();
    const row: Row = { id: crypto.randomUUID(), created_at: now, ...structuredClone(input) };
    if (HAS_UPDATED_AT.has(table)) row.updated_at = row.updated_at ?? now;
    for (const col of TIMESTAMPTZ_COLUMNS) {
      if (typeof row[col] === "string") row[col] = pgTimestamp(row[col]);
    }
    if (table === "appointments") {
      row.status ??= "scheduled";
      row.source ??= "agent_inbound";
      row.resource = row.kind === "phone_call" ? "call" : "visit";
    }
    if (table === "leads") {
      row.status ??= "new";
      row.source ??= "agent_inbound";
    }
    if (table === "work_orders") {
      row.status ??= "new";
      row.source ??= "manual";
    }
    if (table === "conversations") row.status ??= "active";
    return row;
  }

  // The unique index: one scheduled appointment per business, resource and
  // start instant.
  scheduledSlotTaken(candidate: Row, ignoreId?: string): boolean {
    if (candidate.status !== "scheduled") return false;
    return this.tables.appointments.some(
      (r) =>
        r.id !== ignoreId &&
        r.status === "scheduled" &&
        r.business_id === candidate.business_id &&
        r.resource === candidate.resource &&
        Date.parse(r.starts_at) === Date.parse(candidate.starts_at),
    );
  }
}

// Adds a row directly: defaults applied, no constraint checks, no error path.
export function seed(db: FakeSupabase, table: string, row: Row): Row {
  const full = db.build(table, row);
  db.tables[table].push(full);
  return full;
}

// A deep copy of every table, for checks and for the trace file.
export function readAllTables(db: FakeSupabase): Record<string, Row[]> {
  return structuredClone(db.tables);
}

const UNIQUE_VIOLATION: DbError = {
  code: "23505",
  message: 'duplicate key value violates unique constraint "uq_appointments_one_per_slot"',
};

// The check constraints on sms_opt_status (migration 20261011220000).
const E164 = /^\+[1-9][0-9]{6,14}$/;
function optStatusViolation(row: Row): DbError | null {
  const bad =
    !["opted_out", "opted_in"].includes(row.status) ||
    !["keyword", "twilio_21610"].includes(row.source) ||
    typeof row.phone !== "string" ||
    !E164.test(row.phone);
  return bad
    ? { code: "23514", message: "new row for relation sms_opt_status violates check constraint" }
    : null;
}

class Query {
  private op: "select" | WriteOp = "select";
  private columns: string[] | null = null;
  private payload: any;
  private conflictColumns: string[] = ["id"];
  private wantCount = false;
  private headOnly = false;
  private filters: Predicate[] = [];
  private ordering: { column: string; ascending: boolean }[] = [];
  private rowLimit: number | null = null;
  private returning = false;

  constructor(
    private db: FakeSupabase,
    private table: string,
  ) {}

  // `{ count: "exact" }` adds the number of matching rows (before any limit) to
  // the result; `head: true` then returns the count and no rows.
  select(columns?: string, options?: { count?: "exact"; head?: boolean }): this {
    const parsed =
      columns && columns.trim() !== "*" ? columns.split(",").map((c) => c.trim()) : null;
    if (this.op !== "select") this.returning = true; // select after insert/update/delete
    this.columns = parsed;
    if (options?.count) this.wantCount = true;
    if (options?.head) this.headOnly = true;
    return this;
  }
  insert(payload: any): this {
    this.op = "insert";
    this.payload = payload;
    return this;
  }
  update(payload: any): this {
    this.op = "update";
    this.payload = payload;
    return this;
  }
  // Insert, or on a match of `onConflict` (comma-separated columns) merge the
  // given columns into the existing row; columns left out are kept.
  upsert(payload: any, options?: { onConflict?: string }): this {
    this.op = "upsert";
    this.payload = payload;
    if (options?.onConflict) this.conflictColumns = options.onConflict.split(",").map((c) => c.trim());
    return this;
  }
  delete(): this {
    this.op = "delete";
    return this;
  }

  eq(column: string, value: any): this {
    this.filters.push(predicateFor("eq", column, value));
    return this;
  }
  neq(column: string, value: any): this {
    this.filters.push(predicateFor("neq", column, value));
    return this;
  }
  gt(column: string, value: any): this {
    this.filters.push(predicateFor("gt", column, value));
    return this;
  }
  gte(column: string, value: any): this {
    this.filters.push(predicateFor("gte", column, value));
    return this;
  }
  lt(column: string, value: any): this {
    this.filters.push(predicateFor("lt", column, value));
    return this;
  }
  lte(column: string, value: any): this {
    this.filters.push(predicateFor("lte", column, value));
    return this;
  }
  is(column: string, value: any): this {
    this.filters.push(predicateFor("is", column, value));
    return this;
  }
  in(column: string, values: any[]): this {
    this.filters.push((r) => values.some((v) => sameValue(r[column], v)));
    return this;
  }
  or(expression: string): this {
    this.filters.push(parseOr(expression));
    return this;
  }
  order(column: string, options?: { ascending?: boolean }): this {
    this.ordering.push({ column, ascending: options?.ascending !== false });
    return this;
  }
  limit(count: number): this {
    this.rowLimit = count;
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => f(row));
  }

  private project(row: Row): Row {
    const copy = structuredClone(row);
    if (!this.columns) return copy;
    return Object.fromEntries(this.columns.map((c) => [c, copy[c]]));
  }

  private execute(): { data: any; error: DbError | null; count?: number | null } {
    const { db, table } = this;
    const rows = db.tables[table];

    if (this.op === "select") {
      const forcedSelect = db.takeForcedFailure(table, "select");
      if (forcedSelect) return { data: null, error: forcedSelect };
      let found = rows.filter((r) => this.matches(r));
      for (const { column, ascending } of [...this.ordering].reverse()) {
        found = [...found].sort((x, y) => {
          const a = comparable(x[column]);
          const b = comparable(y[column]);
          const cmp = a < b ? -1 : a > b ? 1 : 0;
          return ascending ? cmp : -cmp;
        });
      }
      const total = found.length;
      if (this.rowLimit !== null) found = found.slice(0, this.rowLimit);
      return {
        data: this.headOnly ? null : found.map((r) => this.project(r)),
        error: null,
        ...(this.wantCount ? { count: total } : {}),
      };
    }

    // A failure queued with failNext() hits the next matching write.
    const forced = db.takeForcedFailure(table, this.op);
    if (forced) {
      db.recordWrite(table, this.op, this.payload, forced);
      return { data: null, error: forced };
    }

    if (this.op === "insert") {
      const inserted: Row[] = [];
      for (const input of Array.isArray(this.payload) ? this.payload : [this.payload]) {
        db.takeInsertHook(table)?.(input);
        const row = db.build(table, input);
        if (table === "appointments" && db.scheduledSlotTaken(row)) {
          const error = { ...UNIQUE_VIOLATION };
          db.recordWrite(table, "insert", this.payload, error);
          return { data: null, error };
        }
        rows.push(row);
        inserted.push(row);
      }
      db.recordWrite(table, "insert", this.payload, null);
      return { data: this.returning ? inserted.map((r) => this.project(r)) : null, error: null };
    }

    if (this.op === "upsert") {
      const written: Row[] = [];
      for (const input of Array.isArray(this.payload) ? this.payload : [this.payload]) {
        const existing = rows.find((r) =>
          this.conflictColumns.every((c) => sameValue(r[c], input[c]) && input[c] != null),
        );
        const candidate = { ...(existing ?? {}), ...structuredClone(input) };
        if (table === "sms_opt_status") {
          const error = optStatusViolation(candidate);
          if (error) {
            db.recordWrite(table, "upsert", this.payload, error);
            return { data: null, error };
          }
        }
        if (existing) {
          Object.assign(existing, candidate);
          if (HAS_UPDATED_AT.has(table)) existing.updated_at = db.nextTimestamp();
          written.push(existing);
        } else {
          const row = db.build(table, input);
          rows.push(row);
          written.push(row);
        }
      }
      db.recordWrite(table, "upsert", this.payload, null);
      return { data: this.returning ? written.map((r) => this.project(r)) : null, error: null };
    }

    if (this.op === "update") {
      const hit = rows.filter((r) => this.matches(r));
      for (const row of hit) {
        const next: Row = { ...row, ...structuredClone(this.payload) };
        for (const col of TIMESTAMPTZ_COLUMNS) {
          if (typeof next[col] === "string") next[col] = pgTimestamp(next[col]);
        }
        if (table === "appointments") {
          next.resource = next.kind === "phone_call" ? "call" : "visit";
          if (db.scheduledSlotTaken(next, row.id)) {
            const error = { ...UNIQUE_VIOLATION };
            db.recordWrite(table, "update", this.payload, error);
            return { data: null, error };
          }
        }
        if (HAS_UPDATED_AT.has(table)) next.updated_at = db.nextTimestamp();
        Object.assign(row, next);
      }
      db.recordWrite(table, "update", this.payload, null);
      return { data: this.returning ? hit.map((r) => this.project(r)) : null, error: null };
    }

    const hit = rows.filter((r) => this.matches(r));
    db.tables[table] = rows.filter((r) => !hit.includes(r));
    db.recordWrite(table, "delete", { deleted: hit.length }, null);
    return { data: this.returning ? hit.map((r) => this.project(r)) : null, error: null };
  }

  async maybeSingle(): Promise<{ data: any; error: DbError | null }> {
    const { data, error } = this.execute();
    if (error) return { data: null, error };
    if (data.length > 1) {
      return { data: null, error: { code: "PGRST116", message: "multiple rows returned" } };
    }
    return { data: data[0] ?? null, error: null };
  }

  async single(): Promise<{ data: any; error: DbError | null }> {
    const { data, error } = this.execute();
    if (error) return { data: null, error };
    if (data.length !== 1) {
      return { data: null, error: { code: "PGRST116", message: "expected exactly one row" } };
    }
    return { data: data[0], error: null };
  }

  then<T1 = { data: any; error: DbError | null; count?: number | null }, T2 = never>(
    onfulfilled?: ((value: { data: any; error: DbError | null; count?: number | null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}
