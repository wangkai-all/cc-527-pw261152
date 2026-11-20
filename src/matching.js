import { now, round2, txn } from './db.js';

export const ANOMALY_TYPES = {
  PRICE_MISMATCH: '价格差异',
  TAX_RATE_CHANGE: '税率变化',
  OVER_INVOICE_QTY: '超量开票',
  DUPLICATE_INVOICE: '重复发票',
  UNMATCHED_INVOICE: '无订单发票',
  OVER_PAYMENT: '超额付款',
  PARTIAL_RECEIPT_PENDING: '部分收货待齐',
};

export const STAGES = {
  purchasing: '采购定价',
  warehouse: '仓储收货',
  vendor_billing: '供应商开票',
  finance: '财务付款',
  tax_policy: '税务政策',
};

const EPS = 1e-6;

/** 取发票日期当天有效的价格/税率修订版本（无则取最早版本）。 */
function effectiveRevision(revisions, invoiceDate) {
  let best = null;
  for (const r of revisions) {
    if (r.effective_from <= invoiceDate && (!best || r.version_no > best.version_no)) best = r;
  }
  return best || revisions[0] || null;
}

function addAnomaly(db, runId, a) {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO anomalies
       (run_id, type, severity, supplier_id, period, invoice_id, invoice_line_id, po_line_id,
        responsible_stage, impact_amount, evidence_json, status, dedupe_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'open', ?)`
    )
    .run(
      runId,
      a.type,
      a.severity,
      a.supplierId,
      a.period,
      a.invoiceId ?? null,
      a.invoiceLineId ?? null,
      a.poLineId ?? null,
      a.stage,
      round2(a.impact),
      JSON.stringify(a.evidence),
      a.dedupeKey
    );
  return res.changes > 0;
}

export function runMatching(db, { supplierId = null, note = null } = {}) {
  return txn(db, () => {
    const runId = db
      .prepare('INSERT INTO match_runs(ran_at, supplier_id, note) VALUES(?,?,?)')
      .run(now(), supplierId, note).lastInsertRowid;
    const supplierIds = supplierId
      ? [supplierId]
      : db.prepare('SELECT id FROM suppliers ORDER BY id').all().map((r) => r.id);
    let links = 0;
    let anomalies = 0;
    for (const sid of supplierIds) {
      const r = matchSupplier(db, runId, sid);
      links += r.links;
      anomalies += r.anomalies;
    }
    return { runId, links, anomalies };
  });
}

function matchSupplier(db, runId, supplierId) {
  let linkCount = 0;
  let anomalyCount = 0;
  const count = (ok) => (ok ? anomalyCount++ : 0);

  const poLines = db
    .prepare(
      `SELECT pl.*, po.po_no, po.order_date, po.supplier_id
       FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
       WHERE po.supplier_id = ? ORDER BY po.order_date, po.po_no, pl.line_no`
    )
    .all(supplierId);
  const poLineById = new Map(poLines.map((l) => [l.id, l]));

  const revisions = db
    .prepare(
      `SELECT r.* FROM po_price_revisions r
       JOIN po_lines pl ON pl.id = r.po_line_id
       JOIN purchase_orders po ON po.id = pl.po_id
       WHERE po.supplier_id = ? ORDER BY r.po_line_id, r.version_no`
    )
    .all(supplierId);
  const revByPoLine = new Map();
  for (const r of revisions) {
    if (!revByPoLine.has(r.po_line_id)) revByPoLine.set(r.po_line_id, []);
    revByPoLine.get(r.po_line_id).push(r);
  }

  const receiptLines = db
    .prepare(
      `SELECT rl.id, rl.po_line_id, rl.qty, r.grn_no, r.receipt_date, r.period
       FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id
       WHERE r.supplier_id = ? ORDER BY r.receipt_date, rl.id`
    )
    .all(supplierId);
  const remaining = new Map(receiptLines.map((r) => [r.id, r.qty]));
  const receiptsByPoLine = new Map();
  for (const r of receiptLines) {
    if (!receiptsByPoLine.has(r.po_line_id)) receiptsByPoLine.set(r.po_line_id, []);
    receiptsByPoLine.get(r.po_line_id).push(r);
  }
  const receivedQty = new Map();
  for (const r of receiptLines) {
    receivedQty.set(r.po_line_id, (receivedQty.get(r.po_line_id) || 0) + r.qty);
  }

  const invLines = db
    .prepare(
      `SELECT il.id AS invoice_line_id, il.po_line_id, il.sku, il.qty, il.unit_price, il.tax_rate, il.amount,
              i.id AS invoice_id, i.invoice_no, i.invoice_date, i.period
       FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
       WHERE i.supplier_id = ? AND i.status = 'open'
       ORDER BY i.invoice_date, i.id, il.id`
    )
    .all(supplierId);

  const insertLink = db.prepare(
    `INSERT INTO match_links(run_id, invoice_line_id, po_line_id, receipt_line_id, qty) VALUES(?,?,?,?,?)`
  );
  const invoicedCum = new Map(); // po_line_id -> 累计开票数量（拆单聚合）

  for (const il of invLines) {
    // 1) 定位 PO 行：优先发票自带引用，否则按 SKU 匹配最早订单
    let poLine = il.po_line_id != null ? poLineById.get(il.po_line_id) : null;
    if (!poLine) {
      poLine =
        poLines.find((l) => l.sku === il.sku && (invoicedCum.get(l.id) || 0) < l.qty - EPS) ||
        poLines.find((l) => l.sku === il.sku) ||
        null;
    }

    if (!poLine) {
      insertLink.run(runId, il.invoice_line_id, null, null, il.qty);
      linkCount++;
      count(
        addAnomaly(db, runId, {
          type: 'UNMATCHED_INVOICE',
          severity: 'high',
          supplierId,
          period: il.period,
          invoiceId: il.invoice_id,
          invoiceLineId: il.invoice_line_id,
          stage: 'vendor_billing',
          impact: il.amount,
          dedupeKey: `UM:${il.invoice_line_id}`,
          evidence: {
            invoice: pickInvoice(il),
            po: null,
            receipts: [],
            payments: paymentsOf(db, il.invoice_id),
            diff: { field: 'sku', expected: '已下单SKU', actual: il.sku },
          },
        })
      );
      continue;
    }

    const revs = revByPoLine.get(poLine.id) || [];
    const eff = effectiveRevision(revs, il.invoice_date);
    const expPrice = eff ? eff.unit_price : poLine.unit_price;
    const expTax = eff ? eff.tax_rate : poLine.tax_rate;
    const receipts = receiptsByPoLine.get(poLine.id) || [];
    const received = receivedQty.get(poLine.id) || 0;

    const evidenceBase = {
      invoice: pickInvoice(il),
      po: {
        po_no: poLine.po_no,
        line_no: poLine.line_no,
        sku: poLine.sku,
        ordered_qty: poLine.qty,
        received_qty: received,
        current_price: poLine.unit_price,
        current_tax_rate: poLine.tax_rate,
        revisions: revs.map((r) => ({
          version_no: r.version_no,
          unit_price: r.unit_price,
          tax_rate: r.tax_rate,
          effective_from: r.effective_from,
          reason: r.reason,
        })),
      },
      receipts: receipts.map((r) => ({ grn_no: r.grn_no, receipt_date: r.receipt_date, qty: r.qty })),
      payments: paymentsOf(db, il.invoice_id),
    };

    // 2) 价格核对（按发票日期的有效修订价）
    if (Math.abs(il.unit_price - expPrice) > 0.005) {
      const matchedOldRevision = revs.some((r) => Math.abs(r.unit_price - il.unit_price) <= 0.005);
      count(
        addAnomaly(db, runId, {
          type: 'PRICE_MISMATCH',
          severity: 'high',
          supplierId,
          period: il.period,
          invoiceId: il.invoice_id,
          invoiceLineId: il.invoice_line_id,
          poLineId: poLine.id,
          // 发票价命中某个旧修订价 → 责任在采购（修订未同步供应商）；否则责任在供应商开票
          stage: matchedOldRevision ? 'purchasing' : 'vendor_billing',
          impact: round2((il.unit_price - expPrice) * il.qty * (1 + il.tax_rate)),
          dedupeKey: `PM:${il.invoice_line_id}`,
          evidence: {
            ...evidenceBase,
            diff: {
              field: 'unit_price',
              expected: expPrice,
              actual: il.unit_price,
              effective_revision: eff ? eff.version_no : null,
              matched_old_revision: matchedOldRevision,
            },
          },
        })
      );
    }

    // 3) 税率核对
    if (Math.abs(il.tax_rate - expTax) > EPS) {
      count(
        addAnomaly(db, runId, {
          type: 'TAX_RATE_CHANGE',
          severity: 'medium',
          supplierId,
          period: il.period,
          invoiceId: il.invoice_id,
          invoiceLineId: il.invoice_line_id,
          poLineId: poLine.id,
          stage: 'tax_policy',
          impact: round2(il.unit_price * il.qty * (il.tax_rate - expTax)),
          dedupeKey: `TX:${il.invoice_line_id}`,
          evidence: {
            ...evidenceBase,
            diff: { field: 'tax_rate', expected: expTax, actual: il.tax_rate },
          },
        })
      );
    }

    // 4) 数量分配：发票数量按收货 FIFO 核销（支持部分收货与拆单聚合）
    let needed = il.qty;
    for (const r of receipts) {
      if (needed <= EPS) break;
      const left = remaining.get(r.id);
      if (left <= EPS) continue;
      const take = Math.min(left, needed);
      remaining.set(r.id, round2(left - take));
      insertLink.run(runId, il.invoice_line_id, poLine.id, r.id, take);
      linkCount++;
      needed = round2(needed - take);
    }
    if (needed > EPS) {
      // 无收货支撑的开票部分
      insertLink.run(runId, il.invoice_line_id, poLine.id, null, needed);
      linkCount++;
      count(
        addAnomaly(db, runId, {
          type: 'OVER_INVOICE_QTY',
          severity: 'high',
          supplierId,
          period: il.period,
          invoiceId: il.invoice_id,
          invoiceLineId: il.invoice_line_id,
          poLineId: poLine.id,
          stage: 'vendor_billing',
          impact: round2(needed * il.unit_price * (1 + il.tax_rate)),
          dedupeKey: `OQ:${il.invoice_line_id}`,
          evidence: {
            ...evidenceBase,
            diff: {
              field: 'qty',
              ordered_qty: poLine.qty,
              received_qty: received,
              cum_invoiced_qty: round2((invoicedCum.get(poLine.id) || 0) + il.qty),
              uncovered_qty: needed,
            },
          },
        })
      );
    }
    invoicedCum.set(poLine.id, round2((invoicedCum.get(poLine.id) || 0) + il.qty));
  }

  // 5) 重复发票：内容指纹相同但发票号不同（同号在入账时已被唯一约束拦截）
  const dupGroups = db
    .prepare(
      `SELECT fingerprint, GROUP_CONCAT(id) AS ids, COUNT(*) AS c
       FROM invoices WHERE supplier_id = ? AND status = 'open'
       GROUP BY fingerprint HAVING c > 1`
    )
    .all(supplierId);
  for (const g of dupGroups) {
    const ids = g.ids.split(',').map(Number).sort((a, b) => a - b);
    const original = db.prepare('SELECT * FROM invoices WHERE id = ?').get(ids[0]);
    for (const dupId of ids.slice(1)) {
      const dup = db.prepare('SELECT * FROM invoices WHERE id = ?').get(dupId);
      const total = round2(
        db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM invoice_lines WHERE invoice_id = ?').get(dupId).s
      );
      count(
        addAnomaly(db, runId, {
          type: 'DUPLICATE_INVOICE',
          severity: 'high',
          supplierId,
          period: dup.period,
          invoiceId: dupId,
          stage: 'vendor_billing',
          impact: total,
          dedupeKey: `DUP:${dupId}`,
          evidence: {
            invoice: { invoice_no: dup.invoice_no, invoice_date: dup.invoice_date, total },
            duplicate_of: { invoice_no: original.invoice_no, invoice_date: original.invoice_date },
            fingerprint: g.fingerprint,
            payments: paymentsOf(db, dupId),
            diff: { field: 'fingerprint', expected: '唯一', actual: `与 ${original.invoice_no} 内容完全一致` },
          },
        })
      );
    }
  }

  // 6) 超额付款
  const openInvoices = db
    .prepare("SELECT id, invoice_no, period FROM invoices WHERE supplier_id = ? AND status = 'open'")
    .all(supplierId);
  for (const inv of openInvoices) {
    const total = round2(
      db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM invoice_lines WHERE invoice_id = ?').get(inv.id).s
    );
    const paid = round2(
      db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE invoice_id = ?').get(inv.id).s
    );
    if (paid - total > 0.005) {
      count(
        addAnomaly(db, runId, {
          type: 'OVER_PAYMENT',
          severity: 'high',
          supplierId,
          period: inv.period,
          invoiceId: inv.id,
          stage: 'finance',
          impact: round2(paid - total),
          dedupeKey: `OP:${inv.id}`,
          evidence: {
            invoice: { invoice_no: inv.invoice_no, total },
            payments: paymentsOf(db, inv.id),
            diff: { field: 'paid_amount', expected: total, actual: paid },
          },
        })
      );
    }
  }

  // 7) 部分收货待齐（提示性）：已有开票但收货未齐的 PO 行
  for (const pl of poLines) {
    const received = receivedQty.get(pl.id) || 0;
    const invoiced = invoicedCum.get(pl.id) || 0;
    if (invoiced > EPS && received < pl.qty - EPS) {
      count(
        addAnomaly(db, runId, {
          type: 'PARTIAL_RECEIPT_PENDING',
          severity: 'low',
          supplierId,
          period: db.prepare('SELECT period FROM purchase_orders WHERE id = ?').get(pl.po_id).period,
          poLineId: pl.id,
          stage: 'warehouse',
          impact: 0,
          dedupeKey: `PR:${pl.id}`,
          evidence: {
            po: { po_no: pl.po_no, line_no: pl.line_no, sku: pl.sku, ordered_qty: pl.qty },
            receipts: (receiptsByPoLine.get(pl.id) || []).map((r) => ({
              grn_no: r.grn_no,
              receipt_date: r.receipt_date,
              qty: r.qty,
            })),
            diff: {
              field: 'qty',
              ordered_qty: pl.qty,
              received_qty: received,
              pending_qty: round2(pl.qty - received),
            },
          },
        })
      );
    }
  }

  return { links: linkCount, anomalies: anomalyCount };
}

function pickInvoice(il) {
  return {
    invoice_no: il.invoice_no,
    invoice_date: il.invoice_date,
    sku: il.sku,
    qty: il.qty,
    unit_price: il.unit_price,
    tax_rate: il.tax_rate,
    amount: il.amount,
  };
}

function paymentsOf(db, invoiceId) {
  return db
    .prepare('SELECT payment_no, amount, pay_date, period FROM payments WHERE invoice_id = ? ORDER BY pay_date')
    .all(invoiceId);
}
