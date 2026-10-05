/* eslint-disable @typescript-eslint/no-explicit-any */
// In-memory stand-in for the Supabase client, covering the query shapes that
// processInbound and the agent tools use. It is not Postgres: no RLS, no
// foreign keys, no triggers. The one database rule it does enforce is the
// unique scheduled-slot index on appointments.

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

export class FakeSupabase {
  tables: Record<string, Row[]> = Object.fromEntries(TABLES.map((t) => [t, [] as Row[]]));
  private lastTimestamp = 0;

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

class Query {
  private op: "select" | "insert" | "update" | "delete" = "select";
  private columns: string[] | null = null;
  private payload: any;
  private filters: Predicate[] = [];
  private ordering: { column: string; ascending: boolean }[] = [];
  private rowLimit: number | null = null;
  private returning = false;

  constructor(
    private db: FakeSupabase,
    private table: string,
  ) {}

  select(columns?: string, _options?: unknown): this {
    const parsed =
      columns && columns.trim() !== "*" ? columns.split(",").map((c) => c.trim()) : null;
    if (this.op !== "select") this.returning = true; // select after insert/update/delete
    this.columns = parsed;
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

  private execute(): { data: any; error: DbError | null } {
    const { db, table } = this;
    const rows = db.tables[table];

    if (this.op === "select") {
      let found = rows.filter((r) => this.matches(r));
      for (const { column, ascending } of [...this.ordering].reverse()) {
        found = [...found].sort((x, y) => {
          const a = comparable(x[column]);
          const b = comparable(y[column]);
          const cmp = a < b ? -1 : a > b ? 1 : 0;
          return ascending ? cmp : -cmp;
        });
      }
      if (this.rowLimit !== null) found = found.slice(0, this.rowLimit);
      return { data: found.map((r) => this.project(r)), error: null };
    }

    if (this.op === "insert") {
      const inserted: Row[] = [];
      for (const input of Array.isArray(this.payload) ? this.payload : [this.payload]) {
        const row = db.build(table, input);
        if (table === "appointments" && db.scheduledSlotTaken(row)) {
          return { data: null, error: { ...UNIQUE_VIOLATION } };
        }
        rows.push(row);
        inserted.push(row);
      }
      return { data: this.returning ? inserted.map((r) => this.project(r)) : null, error: null };
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
            return { data: null, error: { ...UNIQUE_VIOLATION } };
          }
        }
        if (HAS_UPDATED_AT.has(table)) next.updated_at = db.nextTimestamp();
        Object.assign(row, next);
      }
      return { data: this.returning ? hit.map((r) => this.project(r)) : null, error: null };
    }

    const hit = rows.filter((r) => this.matches(r));
    db.tables[table] = rows.filter((r) => !hit.includes(r));
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

  then<T1 = { data: any; error: DbError | null }, T2 = never>(
    onfulfilled?: ((value: { data: any; error: DbError | null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: any) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}
