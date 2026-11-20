import { openDb } from '../src/db.js';
import { ingestPo, ingestPriceRevision, ingestReceipt, ingestInvoice, ingestPayment } from '../src/ingest.js';

/**
 * 演示夹具，覆盖全部异常场景：
 * - PO-1001 行1：部分收货（60+40 跨期）+ 价格修订（500→480，2026-10-15 生效）
 * - INV-A1：修订前按旧价开票 → 正常
 * - INV-A2：修订生效后仍按旧价 500 开票 → 价格差异（责任：采购）
 * - INV-A3：与 INV-A2 内容完全一致的换号发票 → 重复发票 + 超量开票
 * - INV-A4：超出累计收货量开票 → 超量开票
 * - PO-1003：收货 50/80 + 已开票 50 → 部分收货待齐
 * - INV-B1：税率 0.16 vs 约定 0.13 → 税率变化；PAY-2 多付 → 超额付款
 * - INV-C1：无 PO 的 SKU → 无订单发票
 * - PAY-1：INV-A1 多付 1000（期间 2026-09，用于跨期测试）
 */
export function buildFixture(db) {
  db.prepare("INSERT INTO suppliers(code, name) VALUES ('S001','华东钢材'), ('S002','苏州电子')").run();

  ingestPo(db, {
    supplier_code: 'S001', po_no: 'PO-1001', order_date: '2026-09-01', period: '2026-09',
    lines: [
      { line_no: 1, sku: 'A100', item_name: '钢板', qty: 100, unit_price: 500, tax_rate: 0.13 },
      { line_no: 2, sku: 'B200', item_name: '螺栓', qty: 1000, unit_price: 2, tax_rate: 0.13 },
    ],
  });
  ingestPriceRevision(db, {
    source_key: 'REV-1', po_no: 'PO-1001', line_no: 1,
    unit_price: 480, effective_from: '2026-10-15', reason: '年度议价降价',
  });
  ingestPo(db, {
    supplier_code: 'S002', po_no: 'PO-1002', order_date: '2026-10-01', period: '2026-10',
    lines: [{ line_no: 1, sku: 'C300', item_name: '芯片', qty: 50, unit_price: 100, tax_rate: 0.13 }],
  });
  ingestPo(db, {
    supplier_code: 'S001', po_no: 'PO-1003', order_date: '2026-10-02', period: '2026-10',
    lines: [{ line_no: 1, sku: 'D400', item_name: '管件', qty: 80, unit_price: 30, tax_rate: 0.13 }],
  });

  ingestReceipt(db, { supplier_code: 'S001', grn_no: 'GRN-1', receipt_date: '2026-09-28', period: '2026-09', lines: [{ po_no: 'PO-1001', line_no: 1, qty: 60 }] });
  ingestReceipt(db, { supplier_code: 'S001', grn_no: 'GRN-2', receipt_date: '2026-10-05', period: '2026-10', lines: [{ po_no: 'PO-1001', line_no: 1, qty: 40 }] });
  ingestReceipt(db, { supplier_code: 'S001', grn_no: 'GRN-3', receipt_date: '2026-09-29', period: '2026-09', lines: [{ po_no: 'PO-1001', line_no: 2, qty: 1000 }] });
  ingestReceipt(db, { supplier_code: 'S002', grn_no: 'GRN-4', receipt_date: '2026-10-12', period: '2026-10', lines: [{ po_no: 'PO-1002', line_no: 1, qty: 50 }] });
  ingestReceipt(db, { supplier_code: 'S001', grn_no: 'GRN-5', receipt_date: '2026-10-08', period: '2026-10', lines: [{ po_no: 'PO-1003', line_no: 1, qty: 50 }] });

  ingestInvoice(db, { supplier_code: 'S001', invoice_no: 'INV-A1', invoice_date: '2026-09-30', period: '2026-09', lines: [{ po_no: 'PO-1001', line_no: 1, sku: 'A100', qty: 60, unit_price: 500, tax_rate: 0.13 }] });
  ingestInvoice(db, { supplier_code: 'S001', invoice_no: 'INV-A2', invoice_date: '2026-10-20', period: '2026-10', lines: [{ po_no: 'PO-1001', line_no: 1, sku: 'A100', qty: 40, unit_price: 500, tax_rate: 0.13 }] });
  ingestInvoice(db, { supplier_code: 'S001', invoice_no: 'INV-A3', invoice_date: '2026-10-20', period: '2026-10', lines: [{ po_no: 'PO-1001', line_no: 1, sku: 'A100', qty: 40, unit_price: 500, tax_rate: 0.13 }] });
  ingestInvoice(db, { supplier_code: 'S001', invoice_no: 'INV-A4', invoice_date: '2026-10-22', period: '2026-10', lines: [{ po_no: 'PO-1001', line_no: 1, sku: 'A100', qty: 10, unit_price: 480, tax_rate: 0.13 }] });
  ingestInvoice(db, { supplier_code: 'S001', invoice_no: 'INV-A5', invoice_date: '2026-10-10', period: '2026-10', lines: [{ po_no: 'PO-1003', line_no: 1, sku: 'D400', qty: 50, unit_price: 30, tax_rate: 0.13 }] });
  ingestInvoice(db, { supplier_code: 'S002', invoice_no: 'INV-B1', invoice_date: '2026-10-15', period: '2026-10', lines: [{ po_no: 'PO-1002', line_no: 1, sku: 'C300', qty: 50, unit_price: 100, tax_rate: 0.16 }] });
  ingestInvoice(db, { supplier_code: 'S002', invoice_no: 'INV-C1', invoice_date: '2026-10-18', period: '2026-10', lines: [{ sku: 'Z999', qty: 1, unit_price: 10, tax_rate: 0.13 }] });

  ingestPayment(db, { supplier_code: 'S001', payment_no: 'PAY-1', invoice_no: 'INV-A1', amount: 34900, pay_date: '2026-10-08', period: '2026-10' });
  ingestPayment(db, { supplier_code: 'S002', payment_no: 'PAY-2', invoice_no: 'INV-B1', amount: 6000, pay_date: '2026-10-30', period: '2026-10' });
}

export function freshDb() {
  const db = openDb(':memory:');
  buildFixture(db);
  return db;
}

export function anomalyByInvoice(db, type, invoiceNo) {
  return db
    .prepare(
      `SELECT a.* FROM anomalies a JOIN invoices i ON i.id = a.invoice_id
       WHERE a.type = ? AND i.invoice_no = ?`
    )
    .get(type, invoiceNo);
}
