import { now, round2 } from './db.js';

/**
 * 为 (供应商, 期间) 生成新的账单版本，并同事务同步待付款清单。
 * 版本内容 = 该期间每张发票的 开票/已付/调整/应付 + 落在本期间的跨期调整行。
 * 调用方需处于事务中（本函数不自行开启事务，以便与修复审批等操作原子提交）。
 */
export function generateBillVersion(db, supplierId, period, reason) {
  const invoices = db
    .prepare('SELECT id, invoice_no, status FROM invoices WHERE supplier_id = ? AND period = ? ORDER BY invoice_no')
    .all(supplierId, period);

  const lines = [];
  for (const inv of invoices) {
    const invoiced = round2(
      db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM invoice_lines WHERE invoice_id = ?').get(inv.id).s
    );
    const paid = round2(
      db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id = ?').get(inv.id).s
    );
    const adj = round2(
      db
        .prepare('SELECT COALESCE(SUM(amount),0) AS s FROM adjustments WHERE invoice_id = ? AND period = ?')
        .get(inv.id, period).s
    );
    lines.push({
      kind: 'invoice',
      invoice_id: inv.id,
      invoiced_amount: invoiced,
      paid_amount: paid,
      adjustment_amount: adj,
      payable_amount: round2(invoiced - paid + adj),
    });
  }

  // 跨期调整：调整入账期间 = 本期间，但被调整发票属于其他期间
  const crossAdj = db
    .prepare(
      `SELECT a.id, a.invoice_id, a.amount FROM adjustments a
       JOIN invoices i ON i.id = a.invoice_id
       WHERE a.supplier_id = ? AND a.period = ? AND i.period <> ?`
    )
    .all(supplierId, period, period);
  for (const a of crossAdj) {
    lines.push({
      kind: 'adjustment',
      invoice_id: a.invoice_id,
      invoiced_amount: 0,
      paid_amount: 0,
      adjustment_amount: a.amount,
      payable_amount: a.amount,
    });
  }

  const payableTotal = round2(lines.reduce((s, l) => s + l.payable_amount, 0));
  const maxV = db
    .prepare('SELECT COALESCE(MAX(version_no),0) AS v FROM bill_versions WHERE supplier_id = ? AND period = ?')
    .get(supplierId, period).v;
  const versionId = db
    .prepare(
      `INSERT INTO bill_versions(supplier_id, period, version_no, reason, payable_total, created_at)
       VALUES(?,?,?,?,?,?)`
    )
    .run(supplierId, period, maxV + 1, reason, payableTotal, now()).lastInsertRowid;

  const insertLine = db.prepare(
    `INSERT INTO bill_version_lines(bill_version_id, kind, invoice_id, invoiced_amount, paid_amount, adjustment_amount, payable_amount)
     VALUES(?,?,?,?,?,?,?)`
  );
  for (const l of lines) {
    insertLine.run(versionId, l.kind, l.invoice_id, l.invoiced_amount, l.paid_amount, l.adjustment_amount, l.payable_amount);
  }

  syncPayableList(db, supplierId, period, versionId, lines);
  return { versionId, versionNo: maxV + 1, payableTotal, lineCount: lines.length };
}

/** 待付款清单与最新版本原子同步：先删后插，调用方事务保证不出现中间态。 */
function syncPayableList(db, supplierId, period, versionId, lines) {
  db.prepare('DELETE FROM payable_list WHERE supplier_id = ? AND period = ?').run(supplierId, period);
  const insert = db.prepare(
    `INSERT INTO payable_list(supplier_id, period, kind, invoice_id, bill_version_id, amount_due, updated_at)
     VALUES(?,?,?,?,?,?,?)`
  );
  const ts = now();
  for (const l of lines) {
    insert.run(supplierId, period, l.kind, l.invoice_id, versionId, l.payable_amount, ts);
  }
}
