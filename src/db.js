import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS periods (
  period TEXT PRIMARY KEY,            -- YYYY-MM
  status TEXT NOT NULL DEFAULT 'open' -- open | closed
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_no TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  order_date TEXT NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  line_no INTEGER NOT NULL,
  sku TEXT NOT NULL,
  item_name TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price REAL NOT NULL,           -- 当前有效价（随修订更新）
  tax_rate REAL NOT NULL,             -- 当前约定税率
  UNIQUE(po_id, line_no)
);

-- 价格/税率修订历史（version_no=1 为下单时的初始版本）
CREATE TABLE IF NOT EXISTS po_price_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_line_id INTEGER NOT NULL REFERENCES po_lines(id),
  version_no INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  tax_rate REAL NOT NULL,
  effective_from TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(po_line_id, version_no)
);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grn_no TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  receipt_date TEXT NOT NULL,
  period TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipt_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES receipts(id),
  po_line_id INTEGER NOT NULL REFERENCES po_lines(id),
  qty REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT NOT NULL,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  invoice_date TEXT NOT NULL,
  period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',  -- open | voided
  fingerprint TEXT NOT NULL,            -- 内容指纹：识别换号重开的重复发票
  created_at TEXT NOT NULL,
  UNIQUE(supplier_id, invoice_no)
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  po_line_id INTEGER REFERENCES po_lines(id),
  sku TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price REAL NOT NULL,
  tax_rate REAL NOT NULL,
  amount REAL NOT NULL                  -- 价税合计
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_no TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount REAL NOT NULL,
  pay_date TEXT NOT NULL,
  period TEXT NOT NULL
);

-- 来源回补幂等台账：同一来源单据重复回补不重复入账
CREATE TABLE IF NOT EXISTS ingest_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,            -- po | price_revision | receipt | invoice | payment
  source_key TEXT NOT NULL,             -- 来源系统唯一键
  doc_id INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_type, source_key)
);

CREATE TABLE IF NOT EXISTS match_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL,
  supplier_id INTEGER,                  -- NULL = 全部供应商
  note TEXT
);

-- 匹配证据链：发票行 → PO行 → 收货行 的数量分配
CREATE TABLE IF NOT EXISTS match_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES match_runs(id),
  invoice_line_id INTEGER NOT NULL REFERENCES invoice_lines(id),
  po_line_id INTEGER REFERENCES po_lines(id),
  receipt_line_id INTEGER REFERENCES receipt_lines(id), -- NULL = 无收货支撑的部分
  qty REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES match_runs(id),
  type TEXT NOT NULL,
  severity TEXT NOT NULL,               -- high | medium | low
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  period TEXT NOT NULL,
  invoice_id INTEGER,
  invoice_line_id INTEGER,
  po_line_id INTEGER,
  responsible_stage TEXT NOT NULL,      -- purchasing | warehouse | vendor_billing | finance | tax_policy
  impact_amount REAL NOT NULL,          -- 影响金额（正数 = 多付风险）
  evidence_json TEXT NOT NULL,          -- 证据链快照
  status TEXT NOT NULL DEFAULT 'open',  -- open | resolved | dismissed
  dedupe_key TEXT NOT NULL UNIQUE       -- 重复跑匹配不重复生成同一异常
);

CREATE TABLE IF NOT EXISTS fixes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  anomaly_id INTEGER NOT NULL REFERENCES anomalies(id),
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  proposed_by TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
-- 同一异常同时只允许一个待审批修复（并发安全）
CREATE UNIQUE INDEX IF NOT EXISTS fixes_one_pending ON fixes(anomaly_id) WHERE status = 'pending';

-- 修复审批通过后生成的调整分录；UNIQUE(fix_id) 保证一个修复只入账一次
CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fix_id INTEGER NOT NULL UNIQUE REFERENCES fixes(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  period TEXT NOT NULL,                 -- 入账期间（跨期时落在最近的开放期间）
  amount REAL NOT NULL,
  memo TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bill_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  period TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  reason TEXT NOT NULL,                 -- initial | backfill | fix_approved
  payable_total REAL NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(supplier_id, period, version_no)
);

CREATE TABLE IF NOT EXISTS bill_version_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_version_id INTEGER NOT NULL REFERENCES bill_versions(id),
  kind TEXT NOT NULL,                   -- invoice | adjustment（跨期调整行）
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  invoiced_amount REAL NOT NULL,
  paid_amount REAL NOT NULL,
  adjustment_amount REAL NOT NULL,
  payable_amount REAL NOT NULL
);

-- 待付款清单：始终与最新账单版本同步（同事务替换）
CREATE TABLE IF NOT EXISTS payable_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  period TEXT NOT NULL,
  kind TEXT NOT NULL,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  bill_version_id INTEGER NOT NULL REFERENCES bill_versions(id),
  amount_due REAL NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(supplier_id, period, kind, invoice_id)
);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function now() {
  return new Date().toISOString();
}

/** node:sqlite 的约束冲突判定：errcode 低 8 位为 19 (SQLITE_CONSTRAINT)。 */
export function isConstraintError(err) {
  return err && typeof err.errcode === 'number' && (err.errcode & 0xff) === 19;
}

export function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

/** 事务包装：BEGIN IMMEDIATE 保证写事务串行，回调内任何异常都会回滚。 */
export function txn(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function ensurePeriod(db, period) {
  db.prepare('INSERT OR IGNORE INTO periods(period, status) VALUES(?, ?)').run(period, 'open');
}

/** 跨期规则：异常所在期间已关闭时，调整落在其后最近的开放期间。 */
export function resolvePostingPeriod(db, period) {
  const row = db.prepare('SELECT status FROM periods WHERE period = ?').get(period);
  if (row && row.status === 'open') return period;
  const next = db
    .prepare("SELECT period FROM periods WHERE period > ? AND status = 'open' ORDER BY period LIMIT 1")
    .get(period);
  if (!next) {
    const err = new Error(`期间 ${period} 已关闭且之后没有开放期间，无法入账`);
    err.status = 422;
    throw err;
  }
  return next.period;
}
