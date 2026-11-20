import { createHash } from 'node:crypto';
import { now, round2, txn, ensurePeriod, isConstraintError } from './db.js';
import { generateBillVersion } from './billing.js';

export function payloadHash(obj) {
  return createHash('sha1').update(JSON.stringify(obj)).digest('hex');
}

export function lineAmount(qty, unitPrice, taxRate) {
  return round2(qty * unitPrice * (1 + taxRate));
}

function invoiceFingerprint(supplierId, invoiceDate, lines) {
  const norm = lines
    .map((l) => [l.sku, l.qty, l.unit_price, l.tax_rate].join(':'))
    .sort()
    .join('|');
  const total = round2(lines.reduce((s, l) => s + lineAmount(l.qty, l.unit_price, l.tax_rate), 0));
  return createHash('sha1').update(`${supplierId}|${invoiceDate}|${total}|${norm}`).digest('hex');
}

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function getSupplierId(db, supplierCode) {
  const row = db.prepare('SELECT id FROM suppliers WHERE code = ?').get(supplierCode);
  if (!row) throw httpError(422, `供应商不存在: ${supplierCode}`, 'NO_SUPPLIER');
  return row.id;
}

function getPoLine(db, poNo, lineNo) {
  const row = db
    .prepare(
      `SELECT pl.id FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
       WHERE po.po_no = ? AND pl.line_no = ?`
    )
    .get(poNo, lineNo);
  if (!row) throw httpError(422, `PO行不存在: ${poNo}#${lineNo}`, 'NO_PO_LINE');
  return row.id;
}

/**
 * 幂等入账包装：同一 (source_type, source_key) 只入账一次。
 * - 重复回补且内容一致 → 返回 deduped，不产生任何写入；
 * - 重复回补但内容不一致 → 409 冲突（防止脏数据覆盖）；
 * - 并发回补 → 检查与写入在同一写事务内串行；唯一约束兜底时整体回滚后按已入账处理。
 */
function ingest(db, sourceType, sourceKey, payload, insertFn) {
  const hash = payloadHash(payload);
  try {
    return txn(db, () => {
      const seen = db
        .prepare('SELECT doc_id, payload_hash FROM ingest_log WHERE source_type = ? AND source_key = ?')
        .get(sourceType, sourceKey);
      if (seen) {
        if (seen.payload_hash !== hash) {
          throw httpError(409, `来源单据 ${sourceType}:${sourceKey} 已入账，但回补内容不一致`, 'CONFLICT');
        }
        return { deduped: true, docId: seen.doc_id };
      }
      const docId = insertFn();
      db.prepare(
        'INSERT INTO ingest_log(source_type, source_key, doc_id, payload_hash, created_at) VALUES(?,?,?,?,?)'
      ).run(sourceType, sourceKey, docId, hash, now());
      return { deduped: false, docId };
    });
  } catch (err) {
    if (isConstraintError(err)) {
      // 事务已整体回滚（含单据写入）。若台账已存在 → 并发回补，按去重处理；
      // 否则是业务唯一约束（发票号/单号重复），报冲突。
      const again = db
        .prepare('SELECT doc_id FROM ingest_log WHERE source_type = ? AND source_key = ?')
        .get(sourceType, sourceKey);
      if (again) return { deduped: true, docId: again.doc_id };
      throw httpError(409, `单据唯一约束冲突，疑似重复回补: ${err.message}`, 'CONFLICT');
    }
    throw err;
  }
}

/** 发票/付款入账成功后，重建该供应商+期间的账单版本并同步待付款清单。 */
function rebuildAfterIngest(db, supplierId, period, deduped) {
  if (deduped) return null; // 回补去重：不生成新版本、不动待付款
  return txn(db, () => {
    const exists = db
      .prepare('SELECT 1 FROM bill_versions WHERE supplier_id = ? AND period = ? LIMIT 1')
      .get(supplierId, period);
    return generateBillVersion(db, supplierId, period, exists ? 'backfill' : 'initial');
  });
}

export function ingestPo(db, body) {
  const supplierId = getSupplierId(db, body.supplier_code);
  ensurePeriod(db, body.period);
  return ingest(db, 'po', body.source_key || body.po_no, body, () => {
    const poId = db
      .prepare(
        'INSERT INTO purchase_orders(po_no, supplier_id, order_date, period) VALUES(?,?,?,?)'
      )
      .run(body.po_no, supplierId, body.order_date, body.period).lastInsertRowid;
    for (const line of body.lines) {
      const poLineId = db
        .prepare(
          'INSERT INTO po_lines(po_id, line_no, sku, item_name, qty, unit_price, tax_rate) VALUES(?,?,?,?,?,?,?)'
        )
        .run(poId, line.line_no, line.sku, line.item_name, line.qty, line.unit_price, line.tax_rate)
        .lastInsertRowid;
      db.prepare(
        `INSERT INTO po_price_revisions(po_line_id, version_no, unit_price, tax_rate, effective_from, reason, created_at)
         VALUES(?,?,?,?,?,?,?)`
      ).run(poLineId, 1, line.unit_price, line.tax_rate, body.order_date, '下单初始价', now());
    }
    return poId;
  });
}

export function ingestPriceRevision(db, body) {
  const poLineId = getPoLine(db, body.po_no, body.line_no);
  return ingest(db, 'price_revision', body.source_key, body, () => {
    const cur = db
      .prepare('SELECT MAX(version_no) AS v FROM po_price_revisions WHERE po_line_id = ?')
      .get(poLineId);
    const versionNo = (cur.v || 0) + 1;
    const prev = db.prepare('SELECT unit_price, tax_rate FROM po_lines WHERE id = ?').get(poLineId);
    const taxRate = body.tax_rate ?? prev.tax_rate;
    const id = db
      .prepare(
        `INSERT INTO po_price_revisions(po_line_id, version_no, unit_price, tax_rate, effective_from, reason, created_at)
         VALUES(?,?,?,?,?,?,?)`
      )
      .run(poLineId, versionNo, body.unit_price, taxRate, body.effective_from, body.reason || null, now())
      .lastInsertRowid;
    // 当前价始终指向最新修订版本
    db.prepare('UPDATE po_lines SET unit_price = ?, tax_rate = ? WHERE id = ?').run(
      body.unit_price,
      taxRate,
      poLineId
    );
    return id;
  });
}

export function ingestReceipt(db, body) {
  const supplierId = getSupplierId(db, body.supplier_code);
  ensurePeriod(db, body.period);
  return ingest(db, 'receipt', body.source_key || body.grn_no, body, () => {
    const receiptId = db
      .prepare('INSERT INTO receipts(grn_no, supplier_id, receipt_date, period) VALUES(?,?,?,?)')
      .run(body.grn_no, supplierId, body.receipt_date, body.period).lastInsertRowid;
    for (const line of body.lines) {
      const poLineId = getPoLine(db, line.po_no, line.line_no);
      db.prepare('INSERT INTO receipt_lines(receipt_id, po_line_id, qty) VALUES(?,?,?)').run(
        receiptId,
        poLineId,
        line.qty
      );
    }
    return receiptId;
  });
}

export function ingestInvoice(db, body) {
  const supplierId = getSupplierId(db, body.supplier_code);
  ensurePeriod(db, body.period);
  const result = ingest(db, 'invoice', body.source_key || `${body.supplier_code}:${body.invoice_no}`, body, () => {
    const fingerprint = invoiceFingerprint(supplierId, body.invoice_date, body.lines);
    const invoiceId = db
      .prepare(
        `INSERT INTO invoices(invoice_no, supplier_id, invoice_date, period, fingerprint, created_at)
         VALUES(?,?,?,?,?,?)`
      )
      .run(body.invoice_no, supplierId, body.invoice_date, body.period, fingerprint, now())
      .lastInsertRowid;
    for (const line of body.lines) {
      let poLineId = null;
      if (line.po_no != null && line.line_no != null) {
        poLineId = getPoLine(db, line.po_no, line.line_no);
      } else {
        const cand = db
          .prepare(
            `SELECT pl.id FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
             WHERE po.supplier_id = ? AND pl.sku = ? ORDER BY po.order_date, pl.line_no LIMIT 1`
          )
          .get(supplierId, line.sku);
        poLineId = cand ? cand.id : null;
      }
      db.prepare(
        `INSERT INTO invoice_lines(invoice_id, po_line_id, sku, qty, unit_price, tax_rate, amount)
         VALUES(?,?,?,?,?,?,?)`
      ).run(
        invoiceId,
        poLineId,
        line.sku,
        line.qty,
        line.unit_price,
        line.tax_rate,
        lineAmount(line.qty, line.unit_price, line.tax_rate)
      );
    }
    return invoiceId;
  });
  const version = rebuildAfterIngest(db, supplierId, body.period, result.deduped);
  return { ...result, billVersionId: version ? version.versionId : null };
}

export function ingestPayment(db, body) {
  const supplierId = getSupplierId(db, body.supplier_code);
  ensurePeriod(db, body.period);
  const result = ingest(db, 'payment', body.source_key || body.payment_no, body, () => {
    const inv = db
      .prepare('SELECT id, period FROM invoices WHERE supplier_id = ? AND invoice_no = ?')
      .get(supplierId, body.invoice_no);
    if (!inv) throw httpError(422, `发票不存在: ${body.invoice_no}`, 'NO_INVOICE');
    return db
      .prepare(
        'INSERT INTO payments(payment_no, supplier_id, invoice_id, amount, pay_date, period) VALUES(?,?,?,?,?,?)'
      )
      .run(body.payment_no, supplierId, inv.id, body.amount, body.pay_date, body.period).lastInsertRowid;
  });
  // 付款影响的是发票所在期间的应付
  const inv = db
    .prepare('SELECT period FROM invoices WHERE supplier_id = ? AND invoice_no = ?')
    .get(supplierId, body.invoice_no);
  const version = rebuildAfterIngest(db, supplierId, inv.period, result.deduped);
  return { ...result, billVersionId: version ? version.versionId : null };
}
