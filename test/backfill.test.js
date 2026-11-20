import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { ingestPo } from '../src/ingest.js';

let db;
let server;
let base;

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO suppliers(code, name) VALUES ('S001','华东钢材')").run();
  ingestPo(db, {
    supplier_code: 'S001', po_no: 'PO-1', order_date: '2026-10-01', period: '2026-10',
    lines: [{ line_no: 1, sku: 'A100', item_name: '钢板', qty: 100, unit_price: 500, tax_rate: 0.13 }],
  });
  server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('来源回补：同一来源单据重复提交不重复入账', async () => {
  const receipt = {
    supplier_code: 'S001', grn_no: 'GRN-100', receipt_date: '2026-10-05', period: '2026-10',
    lines: [{ po_no: 'PO-1', line_no: 1, qty: 30 }],
  };
  const r1 = await post('/api/ingest/receipt', receipt);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.deduped, false);

  const r2 = await post('/api/ingest/receipt', receipt);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.deduped, true, '重复回补应被去重');
  assert.equal(r2.body.docId, r1.body.docId);

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM receipts').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM receipt_lines').get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM ingest_log WHERE source_type = 'receipt'").get().c, 1);
});

test('并发回补：10 个并发相同发票请求只入账一次，待付款不重复', async () => {
  const invoice = {
    supplier_code: 'S001', invoice_no: 'INV-900', invoice_date: '2026-10-10', period: '2026-10',
    lines: [{ po_no: 'PO-1', line_no: 1, sku: 'A100', qty: 10, unit_price: 500, tax_rate: 0.13 }],
  };
  const results = await Promise.all(Array.from({ length: 10 }, () => post('/api/ingest/invoice', invoice)));
  const accepted = results.filter((r) => r.status === 200 && r.body.deduped === false);
  const deduped = results.filter((r) => r.status === 200 && r.body.deduped === true);
  assert.equal(accepted.length, 1, '并发下只能有一个请求真正入账');
  assert.equal(deduped.length, 9);

  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM invoices').get().c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM invoice_lines').get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM ingest_log WHERE source_type = 'invoice'").get().c, 1);

  // 待付款清单中该发票只出现一次，金额 = 10*500*1.13 = 5650
  const rows = db.prepare('SELECT * FROM payable_list').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount_due, 5650);

  // 去重的回补不产生新账单版本
  const v1 = db.prepare('SELECT COUNT(*) AS c FROM bill_versions').get().c;
  await post('/api/ingest/invoice', invoice);
  const v2 = db.prepare('SELECT COUNT(*) AS c FROM bill_versions').get().c;
  assert.equal(v1, v2, '重复回补不得生成新版本');
});

test('冲突回补：同一来源键内容不一致 → 409，且不产生任何写入', async () => {
  const receipt = {
    supplier_code: 'S001', grn_no: 'GRN-100', receipt_date: '2026-10-05', period: '2026-10',
    lines: [{ po_no: 'PO-1', line_no: 1, qty: 99 }], // 与已入账的 qty=30 冲突
  };
  const r = await post('/api/ingest/receipt', receipt);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /不一致/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM receipts').get().c, 1, '冲突回补不得落库');
});

test('业务唯一约束：不同来源键但发票号重复 → 409', async () => {
  const dup = {
    source_key: 'erp-line-999',
    supplier_code: 'S001', invoice_no: 'INV-900', invoice_date: '2026-10-11', period: '2026-10',
    lines: [{ sku: 'A100', qty: 1, unit_price: 1, tax_rate: 0.13 }],
  };
  const r = await post('/api/ingest/invoice', dup);
  assert.equal(r.status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM invoices').get().c, 1);
});
