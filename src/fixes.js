import { now, round2, txn, resolvePostingPeriod, isConstraintError } from './db.js';
import { generateBillVersion } from './billing.js';

/** 各异常类型允许的修复动作 */
export const FIX_ACTIONS = {
  PRICE_MISMATCH: ['adjust_to_po_price', 'dismiss'],
  TAX_RATE_CHANGE: ['accept_tax_diff', 'adjust_tax_diff', 'dismiss'],
  OVER_INVOICE_QTY: ['hold_overbilled', 'dismiss'],
  DUPLICATE_INVOICE: ['void_duplicate', 'dismiss'],
  UNMATCHED_INVOICE: ['reject_invoice', 'dismiss'],
  OVER_PAYMENT: ['refund_overpayment', 'dismiss'],
  PARTIAL_RECEIPT_PENDING: ['dismiss'],
};

export const ACTION_LABELS = {
  adjust_to_po_price: '按PO有效价调整应付',
  accept_tax_diff: '确认税率差（政策原因，照付）',
  adjust_tax_diff: '税率差挂账扣回',
  hold_overbilled: '暂扣超开部分',
  void_duplicate: '作废重复发票',
  reject_invoice: '拒付无单发票',
  refund_overpayment: '超额付款挂账追回',
  dismiss: '确认无误，关闭异常',
};

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

export function proposeFix(db, anomalyId, action, proposedBy) {
  return txn(db, () => {
    const anomaly = db.prepare('SELECT * FROM anomalies WHERE id = ?').get(anomalyId);
    if (!anomaly) throw httpError(404, `异常不存在: ${anomalyId}`, 'NOT_FOUND');
    if (anomaly.status !== 'open') throw httpError(409, `异常已处理（${anomaly.status}），不能再发起修复`, 'CLOSED');
    const allowed = FIX_ACTIONS[anomaly.type] || [];
    if (!allowed.includes(action)) {
      throw httpError(422, `异常类型 ${anomaly.type} 不支持修复动作 ${action}`, 'BAD_ACTION');
    }
    const payload = {
      impact_amount: anomaly.impact_amount,
      adjustment_amount: adjustmentAmount(action, anomaly.impact_amount),
    };
    try {
      const id = db
        .prepare(
          `INSERT INTO fixes(anomaly_id, action, payload_json, status, proposed_by, created_at)
           VALUES(?,?,?, 'pending', ?, ?)`
        )
        .run(anomalyId, action, JSON.stringify(payload), proposedBy || null, now()).lastInsertRowid;
      return { fixId: id, payload };
    } catch (err) {
      if (isConstraintError(err)) {
        throw httpError(409, '该异常已存在待审批的修复方案', 'PENDING_EXISTS');
      }
      throw err;
    }
  });
}

function adjustmentAmount(action, impact) {
  switch (action) {
    case 'adjust_to_po_price':
    case 'adjust_tax_diff':
    case 'hold_overbilled':
    case 'void_duplicate':
    case 'reject_invoice':
      return -round2(impact); // 冲减应付
    case 'refund_overpayment':
      return round2(impact); // 多付导致应付为负，调整回正归零
    case 'accept_tax_diff':
    case 'dismiss':
    default:
      return 0;
  }
}

export function approveFix(db, fixId, approvedBy) {
  return txn(db, () => {
    // 条件更新保证并发审批只有一个成功
    const decided = db
      .prepare("UPDATE fixes SET status = 'approved', approved_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(approvedBy || null, now(), fixId);
    if (decided.changes === 0) {
      const cur = db.prepare('SELECT status FROM fixes WHERE id = ?').get(fixId);
      if (!cur) throw httpError(404, `修复单不存在: ${fixId}`, 'NOT_FOUND');
      throw httpError(409, `修复单已被处理（${cur.status}）`, 'ALREADY_DECIDED');
    }
    const fix = db.prepare('SELECT * FROM fixes WHERE id = ?').get(fixId);
    const anomaly = db.prepare('SELECT * FROM anomalies WHERE id = ?').get(fix.anomaly_id);
    const payload = JSON.parse(fix.payload_json);

    // 跨期规则：异常期间已关闭 → 调整落在最近的开放期间
    const postingPeriod = resolvePostingPeriod(db, anomaly.period);

    if (fix.action === 'void_duplicate' || fix.action === 'reject_invoice') {
      db.prepare("UPDATE invoices SET status = 'voided' WHERE id = ?").run(anomaly.invoice_id);
    }

    // UNIQUE(fix_id) 兜底：同一修复只入账一次。
    // 纯关闭类动作（dismiss / accept_tax_diff）且无发票关联时不产生分录。
    const needsAdjustment =
      payload.adjustment_amount !== 0 || fix.action === 'void_duplicate' || fix.action === 'reject_invoice';
    if (needsAdjustment) {
      db.prepare(
        `INSERT INTO adjustments(fix_id, supplier_id, invoice_id, period, amount, memo, created_at)
         VALUES(?,?,?,?,?,?,?)`
      ).run(
        fixId,
        anomaly.supplier_id,
        anomaly.invoice_id,
        postingPeriod,
        payload.adjustment_amount,
        `${fix.action} @ anomaly#${anomaly.id}`,
        now()
      );
    }

    db.prepare("UPDATE anomalies SET status = 'resolved' WHERE id = ?").run(anomaly.id);

    // 确认修复后生成新版本并同步待付款清单（异常期间 + 调整入账期间）
    const versions = [];
    for (const period of new Set([anomaly.period, postingPeriod])) {
      versions.push(generateBillVersion(db, anomaly.supplier_id, period, 'fix_approved'));
    }
    return { fixId, postingPeriod, adjustment: payload.adjustment_amount, versions };
  });
}

export function rejectFix(db, fixId, decidedBy) {
  return txn(db, () => {
    const decided = db
      .prepare("UPDATE fixes SET status = 'rejected', approved_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(decidedBy || null, now(), fixId);
    if (decided.changes === 0) {
      const cur = db.prepare('SELECT status FROM fixes WHERE id = ?').get(fixId);
      if (!cur) throw httpError(404, `修复单不存在: ${fixId}`, 'NOT_FOUND');
      throw httpError(409, `修复单已被处理（${cur.status}）`, 'ALREADY_DECIDED');
    }
    return { fixId };
  });
}
