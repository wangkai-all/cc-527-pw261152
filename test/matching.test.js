import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, anomalyByInvoice } from '../test-utils/helpers.js';
import { runMatching } from '../src/matching.js';
import { runTrace } from '../src/queries.js';

test('三单匹配：部分收货 + 拆单聚合开票不产生误报', () => {
  const db = freshDb();
  const { runId } = runMatching(db);

  // INV-A1(60) + INV-A2(40) 拆单开票，合计 100 = 累计收货 100 → 数量上无异常
  assert.equal(anomalyByInvoice(db, 'OVER_INVOICE_QTY', 'INV-A1'), undefined);
  assert.equal(anomalyByInvoice(db, 'OVER_INVOICE_QTY', 'INV-A2'), undefined);

  // 匹配证据链：INV-A1 的 60 全部来自 GRN-1，INV-A2 的 40 全部来自 GRN-2（部分收货跨期核销）
  const trace = runTrace(db, runId);
  const a1 = trace.filter((l) => l.invoice_no === 'INV-A1');
  assert.equal(a1.length, 1);
  assert.equal(a1[0].grn_no, 'GRN-1');
  assert.equal(a1[0].allocated_qty, 60);
  assert.equal(a1[0].match_status, 'matched');
  const a2 = trace.filter((l) => l.invoice_no === 'INV-A2');
  assert.equal(a2.length, 1);
  assert.equal(a2[0].grn_no, 'GRN-2');
  assert.equal(a2[0].allocated_qty, 40);
});

test('价格修订：按发票日期取有效价，命中旧修订价 → 责任环节为采购', () => {
  const db = freshDb();
  runMatching(db);

  // INV-A1（2026-09-30）在修订生效前按 500 开票 → 不误报
  assert.equal(anomalyByInvoice(db, 'PRICE_MISMATCH', 'INV-A1'), undefined);

  // INV-A2（2026-10-20）修订生效后仍按 500 开票 → 价格差异，影响 = (500-480)*40*1.13 = 904
  const pm = anomalyByInvoice(db, 'PRICE_MISMATCH', 'INV-A2');
  assert.ok(pm, '应检出价格差异');
  assert.equal(pm.impact_amount, 904);
  assert.equal(pm.responsible_stage, 'purchasing'); // 发票价命中旧修订价 → 采购未同步供应商
  const ev = JSON.parse(pm.evidence_json);
  assert.equal(ev.diff.expected, 480);
  assert.equal(ev.diff.actual, 500);
  assert.equal(ev.po.revisions.length, 2); // 证据链含完整修订历史
  assert.equal(ev.diff.matched_old_revision, true);
});

test('税率变化：发票税率高于约定税率 → 影响金额为税额差', () => {
  const db = freshDb();
  runMatching(db);
  const tx = anomalyByInvoice(db, 'TAX_RATE_CHANGE', 'INV-B1');
  assert.ok(tx, '应检出税率变化');
  assert.equal(tx.impact_amount, 150); // 50*100*(0.16-0.13)
  assert.equal(tx.responsible_stage, 'tax_policy');
  const ev = JSON.parse(tx.evidence_json);
  assert.equal(ev.diff.expected, 0.13);
  assert.equal(ev.diff.actual, 0.16);
});

test('重复发票：换号重开内容一致 → 按内容指纹检出，证据链指向原票', () => {
  const db = freshDb();
  runMatching(db);
  const dup = anomalyByInvoice(db, 'DUPLICATE_INVOICE', 'INV-A3');
  assert.ok(dup, '应检出重复发票');
  assert.equal(dup.impact_amount, 22600); // 40*500*1.13
  assert.equal(dup.responsible_stage, 'vendor_billing');
  const ev = JSON.parse(dup.evidence_json);
  assert.equal(ev.duplicate_of.invoice_no, 'INV-A2');
});

test('超量开票：累计开票超过累计收货的部分单独定位', () => {
  const db = freshDb();
  runMatching(db);
  // INV-A4 开票 10，此时收货 100 已被 INV-A1/A2/A3 占满 → 10 全部无收货支撑
  const oq = anomalyByInvoice(db, 'OVER_INVOICE_QTY', 'INV-A4');
  assert.ok(oq, '应检出超量开票');
  assert.equal(oq.impact_amount, 5424); // 10*480*1.13
  const ev = JSON.parse(oq.evidence_json);
  assert.equal(ev.diff.uncovered_qty, 10);
  assert.equal(ev.diff.received_qty, 100);
});

test('无订单发票与超额付款', () => {
  const db = freshDb();
  runMatching(db);
  const um = anomalyByInvoice(db, 'UNMATCHED_INVOICE', 'INV-C1');
  assert.ok(um, '应检出无订单发票');
  assert.equal(um.impact_amount, 11.3);

  const op1 = anomalyByInvoice(db, 'OVER_PAYMENT', 'INV-A1');
  assert.equal(op1.impact_amount, 1000); // 付 34900 vs 票 33900
  assert.equal(op1.period, '2026-09'); // 异常归属发票期间（跨期测试用）
  assert.equal(op1.responsible_stage, 'finance');

  const op2 = anomalyByInvoice(db, 'OVER_PAYMENT', 'INV-B1');
  assert.equal(op2.impact_amount, 200); // 付 6000 vs 票 5800
});

test('部分收货待齐：已开票但收货未齐的 PO 行给出提示', () => {
  const db = freshDb();
  runMatching(db);
  const pr = db.prepare("SELECT * FROM anomalies WHERE type = 'PARTIAL_RECEIPT_PENDING'").get();
  assert.ok(pr, '应提示部分收货待齐');
  assert.equal(pr.responsible_stage, 'warehouse');
  assert.equal(pr.impact_amount, 0);
  const ev = JSON.parse(pr.evidence_json);
  assert.equal(ev.diff.ordered_qty, 80);
  assert.equal(ev.diff.received_qty, 50);
  assert.equal(ev.diff.pending_qty, 30);
});

test('重复跑匹配：异常按去重键幂等，不重复生成', () => {
  const db = freshDb();
  const r1 = runMatching(db);
  const n1 = db.prepare('SELECT COUNT(*) AS c FROM anomalies').get().c;
  assert.ok(r1.anomalies > 0);
  const r2 = runMatching(db);
  const n2 = db.prepare('SELECT COUNT(*) AS c FROM anomalies').get().c;
  assert.equal(r2.anomalies, 0, '第二次运行不应产生新异常');
  assert.equal(n1, n2);
});
