import { ANOMALY_TYPES, STAGES } from './matching.js';
import { ACTION_LABELS } from './fixes.js';
import { round2 } from './db.js';

export function listRuns(db) {
  return db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM match_links ml WHERE ml.run_id = r.id) AS link_count,
              (SELECT COUNT(*) FROM anomalies a WHERE a.run_id = r.id) AS anomaly_count
       FROM match_runs r ORDER BY r.id DESC LIMIT 50`
    )
    .all();
}

export function runTrace(db, runId) {
  return db
    .prepare(
      `SELECT ml.id, ml.qty AS allocated_qty,
              i.invoice_no, i.invoice_date, il.sku, il.qty AS invoiced_qty, il.unit_price, il.tax_rate, il.amount,
              po.po_no, pl.line_no AS po_line_no, pl.qty AS ordered_qty,
              r.grn_no, r.receipt_date, rl.qty AS receipt_qty,
              CASE WHEN ml.po_line_id IS NULL THEN 'unmatched'
                   WHEN ml.receipt_line_id IS NULL THEN 'no_receipt'
                   ELSE 'matched' END AS match_status
       FROM match_links ml
       JOIN invoice_lines il ON il.id = ml.invoice_line_id
       JOIN invoices i ON i.id = il.invoice_id
       LEFT JOIN po_lines pl ON pl.id = ml.po_line_id
       LEFT JOIN purchase_orders po ON po.id = pl.po_id
       LEFT JOIN receipt_lines rl ON rl.id = ml.receipt_line_id
       LEFT JOIN receipts r ON r.id = rl.receipt_id
       WHERE ml.run_id = ?
       ORDER BY i.invoice_no, il.id, ml.id`
    )
    .all(runId);
}

export function listAnomalies(db, { status, type, supplierId } = {}) {
  const cond = [];
  const args = [];
  if (status) {
    cond.push('a.status = ?');
    args.push(status);
  }
  if (type) {
    cond.push('a.type = ?');
    args.push(type);
  }
  if (supplierId) {
    cond.push('a.supplier_id = ?');
    args.push(supplierId);
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT a.id, a.run_id, a.type, a.severity, a.status, a.period, a.responsible_stage, a.impact_amount,
              a.invoice_id, a.invoice_line_id, a.po_line_id, a.supplier_id,
              s.code AS supplier_code, s.name AS supplier_name,
              i.invoice_no,
              (SELECT COUNT(*) FROM fixes f WHERE f.anomaly_id = a.id AND f.status = 'pending') AS pending_fixes
       FROM anomalies a
       JOIN suppliers s ON s.id = a.supplier_id
       LEFT JOIN invoices i ON i.id = a.invoice_id
       ${where}
       ORDER BY a.status = 'open' DESC, a.impact_amount DESC, a.id`
    )
    .all(...args);
}

export function getAnomaly(db, id) {
  const a = db
    .prepare(
      `SELECT a.*, s.code AS supplier_code, s.name AS supplier_name, i.invoice_no
       FROM anomalies a
       JOIN suppliers s ON s.id = a.supplier_id
       LEFT JOIN invoices i ON i.id = a.invoice_id
       WHERE a.id = ?`
    )
    .get(id);
  if (!a) return null;
  return {
    ...a,
    evidence: JSON.parse(a.evidence_json),
    fixes: db
      .prepare('SELECT id, action, status, proposed_by, approved_by, created_at, decided_at FROM fixes WHERE anomaly_id = ? ORDER BY id DESC')
      .all(id),
  };
}

export function listFixes(db, { status } = {}) {
  const where = status ? 'WHERE f.status = ?' : '';
  const args = status ? [status] : [];
  return db
    .prepare(
      `SELECT f.*, a.type AS anomaly_type, a.impact_amount, a.period AS anomaly_period,
              s.code AS supplier_code, s.name AS supplier_name, i.invoice_no
       FROM fixes f
       JOIN anomalies a ON a.id = f.anomaly_id
       JOIN suppliers s ON s.id = a.supplier_id
       LEFT JOIN invoices i ON i.id = a.invoice_id
       ${where}
       ORDER BY f.status = 'pending' DESC, f.id DESC`
    )
    .all(...args);
}

export function listVersions(db, { supplierId, period } = {}) {
  const cond = [];
  const args = [];
  if (supplierId) {
    cond.push('v.supplier_id = ?');
    args.push(supplierId);
  }
  if (period) {
    cond.push('v.period = ?');
    args.push(period);
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT v.*, s.code AS supplier_code, s.name AS supplier_name
       FROM bill_versions v JOIN suppliers s ON s.id = v.supplier_id
       ${where} ORDER BY v.supplier_id, v.period, v.version_no DESC`
    )
    .all(...args);
}

export function getVersion(db, id) {
  const v = db
    .prepare(
      `SELECT v.*, s.code AS supplier_code, s.name AS supplier_name
       FROM bill_versions v JOIN suppliers s ON s.id = v.supplier_id WHERE v.id = ?`
    )
    .get(id);
  if (!v) return null;
  v.lines = db
    .prepare(
      `SELECT l.*, i.invoice_no, i.period AS invoice_period, i.status AS invoice_status
       FROM bill_version_lines l JOIN invoices i ON i.id = l.invoice_id
       WHERE l.bill_version_id = ? ORDER BY l.kind, i.invoice_no`
    )
    .all(id);
  return v;
}

export function listPayables(db, { supplierId, period } = {}) {
  const cond = [];
  const args = [];
  if (supplierId) {
    cond.push('p.supplier_id = ?');
    args.push(supplierId);
  }
  if (period) {
    cond.push('p.period = ?');
    args.push(period);
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT p.*, s.code AS supplier_code, s.name AS supplier_name, i.invoice_no, i.period AS invoice_period,
              v.version_no, v.reason AS version_reason
       FROM payable_list p
       JOIN suppliers s ON s.id = p.supplier_id
       JOIN invoices i ON i.id = p.invoice_id
       JOIN bill_versions v ON v.id = p.bill_version_id
       ${where}
       ORDER BY s.code, p.period, i.invoice_no`
    )
    .all(...args);
}

export function summary(db) {
  const byType = db
    .prepare(
      `SELECT type, COUNT(*) AS cnt,
              SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_cnt,
              ROUND(SUM(impact_amount), 2) AS impact,
              ROUND(SUM(CASE WHEN status = 'open' THEN impact_amount ELSE 0 END), 2) AS open_impact
       FROM anomalies GROUP BY type ORDER BY impact DESC`
    )
    .all()
    .map((r) => ({ ...r, label: ANOMALY_TYPES[r.type] || r.type }));
  const byStage = db
    .prepare(
      `SELECT responsible_stage AS stage, COUNT(*) AS cnt, ROUND(SUM(impact_amount), 2) AS impact
       FROM anomalies GROUP BY responsible_stage ORDER BY impact DESC`
    )
    .all()
    .map((r) => ({ ...r, label: STAGES[r.stage] || r.stage }));
  const totals = {
    suppliers: db.prepare('SELECT COUNT(*) AS c FROM suppliers').get().c,
    invoices: db.prepare('SELECT COUNT(*) AS c FROM invoices').get().c,
    open_anomalies: db.prepare("SELECT COUNT(*) AS c FROM anomalies WHERE status = 'open'").get().c,
    open_impact: round2(db.prepare("SELECT COALESCE(SUM(impact_amount),0) AS s FROM anomalies WHERE status = 'open'").get().s),
    payable_total: round2(db.prepare('SELECT COALESCE(SUM(amount_due),0) AS s FROM payable_list').get().s),
    pending_fixes: db.prepare("SELECT COUNT(*) AS c FROM fixes WHERE status = 'pending'").get().c,
  };
  const runs = listRuns(db).slice(0, 5);
  return { totals, by_type: byType, by_stage: byStage, runs };
}

export function meta(db) {
  return {
    suppliers: db.prepare('SELECT id, code, name FROM suppliers ORDER BY code').all(),
    periods: db.prepare('SELECT period, status FROM periods ORDER BY period').all(),
    anomaly_types: Object.entries(ANOMALY_TYPES).map(([value, label]) => ({ value, label })),
    stages: Object.entries(STAGES).map(([value, label]) => ({ value, label })),
    fix_actions: Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label })),
  };
}
