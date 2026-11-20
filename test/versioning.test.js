import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, anomalyByInvoice } from '../test-utils/helpers.js';
import { runMatching } from '../src/matching.js';
import { proposeFix, approveFix, rejectFix } from '../src/fixes.js';
import { listPayables, getVersion } from '../src/queries.js';

function latestVersionNo(db, supplierCode, period) {
  return db
    .prepare(
      `SELECT COALESCE(MAX(v.version_no),0) AS v FROM bill_versions v
       JOIN suppliers s ON s.id = v.supplier_id WHERE s.code = ? AND v.period = ?`
    )
    .get(supplierCode, period).v;
}

function payableOf(db, invoiceNo) {
  return db
    .prepare(
      `SELECT p.amount_due FROM payable_list p JOIN invoices i ON i.id = p.invoice_id
       WHERE i.invoice_no = ? AND p.kind = 'invoice'`
    )
    .get(invoiceNo)?.amount_due;
}

test('修复审批：确认后生成新版本并同步待付款清单', () => {
  const db = freshDb();
  runMatching(db);

  const pm = anomalyByInvoice(db, 'PRICE_MISMATCH', 'INV-A2');
  const vBefore = latestVersionNo(db, 'S001', '2026-10');
  assert.equal(payableOf(db, 'INV-A2'), 22600); // 40*500*1.13

  const { fixId, payload } = proposeFix(db, pm.id, 'adjust_to_po_price', 'wang');
  assert.equal(payload.adjustment_amount, -904);

  const result = approveFix(db, fixId, 'cfo');
  assert.equal(result.postingPeriod, '2026-10');

  // 异常关闭、分录入账
  assert.equal(db.prepare('SELECT status FROM anomalies WHERE id = ?').get(pm.id).status, 'resolved');
  const adj = db.prepare('SELECT * FROM adjustments WHERE fix_id = ?').get(fixId);
  assert.equal(adj.amount, -904);
  assert.equal(adj.period, '2026-10');

  // 生成新版本且待付款清单同步：INV-A2 应付 = 22600 - 904 = 21696 = 40*480*1.13
  const vAfter = latestVersionNo(db, 'S001', '2026-10');
  assert.ok(vAfter > vBefore, '审批后必须生成新版本');
  assert.equal(payableOf(db, 'INV-A2'), 21696);

  // 版本行与待付款清单一一对应
  const version = getVersion(db, db.prepare('SELECT id FROM bill_versions WHERE supplier_id = (SELECT id FROM suppliers WHERE code = ?) AND period = ? ORDER BY version_no DESC').get('S001', '2026-10').id);
  const payables = listPayables(db, { period: '2026-10' }).filter((p) => p.supplier_code === 'S001');
  assert.equal(version.lines.length, payables.length);
});

test('审批幂等：重复审批与并发审批都只入账一次', () => {
  const db = freshDb();
  runMatching(db);
  const oq = anomalyByInvoice(db, 'OVER_INVOICE_QTY', 'INV-A4');
  const { fixId } = proposeFix(db, oq.id, 'hold_overbilled', 'wang');

  approveFix(db, fixId, 'cfo');
  assert.throws(() => approveFix(db, fixId, 'cfo'), /已被处理/);
  assert.throws(() => rejectFix(db, fixId, 'cfo'), /已被处理/);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM adjustments WHERE fix_id = ?').get(fixId).c, 1);

  // 并发审批：两个同时点通过，只有一个生效
  const op = anomalyByInvoice(db, 'OVER_PAYMENT', 'INV-B1');
  const { fixId: fix2 } = proposeFix(db, op.id, 'refund_overpayment', 'wang');
  const results = [() => approveFix(db, fix2, 'cfo'), () => approveFix(db, fix2, 'cfo2')].map((fn) => {
    try {
      return { ok: true, value: fn() };
    } catch (err) {
      return { ok: false, err };
    }
  });
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM adjustments WHERE fix_id = ?').get(fix2).c, 1);
});

test('作废重复发票：发票作废 + 应付清零 + 后续匹配不再报重复', () => {
  const db = freshDb();
  runMatching(db);
  const dup = anomalyByInvoice(db, 'DUPLICATE_INVOICE', 'INV-A3');
  const { fixId } = proposeFix(db, dup.id, 'void_duplicate', 'wang');
  approveFix(db, fixId, 'cfo');

  assert.equal(db.prepare("SELECT status FROM invoices WHERE invoice_no = 'INV-A3'").get().status, 'voided');
  assert.equal(payableOf(db, 'INV-A3'), 0); // 22600 - 22600

  // 重新匹配：INV-A3 已作废，不再产生新的重复/超开异常
  const before = db.prepare('SELECT COUNT(*) AS c FROM anomalies').get().c;
  runMatching(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM anomalies').get().c, before);
});

test('跨期：异常期间已关闭 → 调整落在最近开放期间，两个期间各自生成新版本', () => {
  const db = freshDb();
  runMatching(db);

  // 关闭 2026-09，INV-A1 的超额付款异常属于该期间
  db.prepare("UPDATE periods SET status = 'closed' WHERE period = '2026-09'").run();
  const op = anomalyByInvoice(db, 'OVER_PAYMENT', 'INV-A1');
  assert.equal(op.period, '2026-09');

  const v09Before = latestVersionNo(db, 'S001', '2026-09');
  const v10Before = latestVersionNo(db, 'S001', '2026-10');

  const { fixId } = proposeFix(db, op.id, 'refund_overpayment', 'wang');
  const result = approveFix(db, fixId, 'cfo');

  // 调整落在 2026-10（最近开放期间），不回写已关闭的 2026-09
  assert.equal(result.postingPeriod, '2026-10');
  const adj = db.prepare('SELECT * FROM adjustments WHERE fix_id = ?').get(fixId);
  assert.equal(adj.period, '2026-10');
  assert.equal(adj.amount, 1000);

  // 两个期间都生成了新版本
  assert.ok(latestVersionNo(db, 'S001', '2026-09') > v09Before);
  assert.ok(latestVersionNo(db, 'S001', '2026-10') > v10Before);

  // 2026-09 的待付款仍反映多付（-1000），2026-10 出现跨期调整行 +1000，两期合计为 0
  assert.equal(payableOf(db, 'INV-A1'), -1000);
  const cross = db
    .prepare(
      `SELECT p.* FROM payable_list p JOIN invoices i ON i.id = p.invoice_id
       WHERE i.invoice_no = 'INV-A1' AND p.kind = 'adjustment' AND p.period = '2026-10'`
    )
    .get();
  assert.ok(cross, '开放期间应出现跨期调整行');
  assert.equal(cross.amount_due, 1000);
});

test('跨期兜底：没有任何开放期间 → 拒绝入账', () => {
  const db = freshDb();
  runMatching(db);
  db.prepare("UPDATE periods SET status = 'closed'").run();
  const op = anomalyByInvoice(db, 'OVER_PAYMENT', 'INV-A1');
  const { fixId } = proposeFix(db, op.id, 'refund_overpayment', 'wang');
  assert.throws(() => approveFix(db, fixId, 'cfo'), /没有开放期间/);
  // 审批失败必须整体回滚：修复单仍是待审批，异常仍未关闭
  assert.equal(db.prepare('SELECT status FROM fixes WHERE id = ?').get(fixId).status, 'pending');
  assert.equal(db.prepare('SELECT status FROM anomalies WHERE id = ?').get(op.id).status, 'open');
});

test('修复方案约束：同一异常同时只允许一个待审批方案', () => {
  const db = freshDb();
  runMatching(db);
  const tx = anomalyByInvoice(db, 'TAX_RATE_CHANGE', 'INV-B1');
  proposeFix(db, tx.id, 'accept_tax_diff', 'wang');
  assert.throws(() => proposeFix(db, tx.id, 'adjust_tax_diff', 'li'), /待审批/);
  // 不合法动作
  assert.throws(() => proposeFix(db, tx.id, 'void_duplicate', 'li'), /不支持/);
});
