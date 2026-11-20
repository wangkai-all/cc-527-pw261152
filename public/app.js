// 供应商账单异常分析 - 前端逻辑
// 约定：所有接口数据均视为不可信文本，一律用 textContent 注入。

const $ = (sel) => document.querySelector(sel);
const tooltip = $('#tooltip');

const SEV = { high: ['高', 'sev-high'], medium: ['中', 'sev-medium'], low: ['低', 'sev-low'] };
const STATUS = {
  open: ['未结', 'st-open'],
  resolved: ['已修复', 'st-resolved'],
  dismissed: ['已关闭', 'st-dismissed'],
  pending: ['待审批', 'st-pending'],
  approved: ['已通过', 'st-approved'],
  rejected: ['已驳回', 'st-rejected'],
};
const MATCH_STATUS = {
  matched: ['已核销', 'match-matched'],
  no_receipt: ['无收货支撑', 'match-no_receipt'],
  unmatched: ['无订单', 'match-unmatched'],
};

let META = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function fmtMoney(n) {
  return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtQty(n) {
  return Number(n).toLocaleString('zh-CN');
}
function fmtTime(s) {
  return s ? String(s).replace('T', ' ').slice(0, 19) : '-';
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function badge([label, cls]) {
  const b = el('span', `badge ${cls}`);
  b.append(el('span', 'dot'), el('span', null, label));
  return b;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function buildTable(table, columns, rows, { onRow } = {}) {
  clear(table);
  const thead = el('thead');
  const tr = el('tr');
  for (const c of columns) tr.append(el('th', c.num ? 'num' : null, c.label));
  thead.append(tr);
  table.append(thead);
  const tbody = el('tbody');
  if (!rows.length) {
    const td = el('td', 'empty', '暂无数据');
    td.colSpan = columns.length;
    tbody.append(el('tr').appendChild(td).parentNode);
  }
  for (const row of rows) {
    const tr = el('tr', onRow ? 'clickable' : null);
    for (const c of columns) {
      const td = el('td', c.num ? 'num' : null);
      const v = c.render ? c.render(row) : row[c.key];
      if (v instanceof Node) td.append(v);
      else td.textContent = v ?? '-';
      tr.append(td);
    }
    if (onRow) tr.addEventListener('click', () => onRow(row));
    tbody.append(tr);
  }
  table.append(tbody);
}

/* ---------- 横向条形图（单系列：细条 + 端部值 + 悬浮提示） ---------- */
function barChart(container, rows, colorVar) {
  clear(container);
  if (!rows.length) {
    container.append(el('div', 'empty', '暂无数据'));
    return;
  }
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  for (const r of rows) {
    const row = el('div', 'bar-row');
    row.tabIndex = 0;
    const cat = el('div', 'cat', r.label);
    cat.title = r.label;
    const track = el('div', 'bar-track');
    const fill = el('div', 'bar-fill');
    fill.style.width = `${Math.max((Math.abs(r.value) / max) * 100, 1)}%`;
    fill.style.background = `var(${colorVar})`;
    track.append(fill);
    const val = el('div', 'bar-val', fmtMoney(r.value));
    row.append(cat, track, val);
    const show = (x, y) => showTooltip(x, y, fmtMoney(r.value), r.label);
    row.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
    row.addEventListener('pointerleave', hideTooltip);
    row.addEventListener('focus', () => {
      const rect = row.getBoundingClientRect();
      show(rect.right, rect.top);
    });
    row.addEventListener('blur', hideTooltip);
    container.append(row);
  }
}

function showTooltip(x, y, value, label) {
  clear(tooltip);
  tooltip.append(el('div', 't-val', value), el('div', 't-label', label));
  tooltip.style.display = 'block';
  const w = tooltip.offsetWidth;
  tooltip.style.left = `${Math.min(x + 14, window.innerWidth - w - 8)}px`;
  tooltip.style.top = `${y + 14}px`;
}
function hideTooltip() {
  tooltip.style.display = 'none';
}

/* ---------- 概览 ---------- */
async function renderOverview() {
  const s = await api('/api/summary');
  const kpis = $('#kpis');
  clear(kpis);
  const tiles = [
    ['供应商', s.totals.suppliers, ''],
    ['未结异常', s.totals.open_anomalies, s.totals.open_anomalies > 0 ? 'warn' : ''],
    ['未结影响金额', `¥${fmtMoney(s.totals.open_impact)}`, s.totals.open_impact > 0 ? 'warn' : ''],
    ['待付款合计', `¥${fmtMoney(s.totals.payable_total)}`, ''],
    ['待审批修复', s.totals.pending_fixes, s.totals.pending_fixes > 0 ? 'warn' : ''],
  ];
  for (const [label, value, cls] of tiles) {
    const k = el('div', 'kpi');
    k.append(el('div', 'label', label), el('div', `value ${cls}`, String(value)));
    kpis.append(k);
  }

  const byType = s.by_type.map((r) => ({ label: r.label, value: r.open_impact, raw: r }));
  const byStage = s.by_stage.map((r) => ({ label: r.label, value: r.impact, raw: r }));
  barChart($('#chart-by-type'), byType, '--series-1');
  barChart($('#chart-by-stage'), byStage, '--series-2');

  buildTable($('#table-by-type'), [
    { label: '异常类型', key: 'label' },
    { label: '异常数', key: 'cnt', num: true },
    { label: '未结', key: 'open_cnt', num: true },
    { label: '影响金额合计', render: (r) => fmtMoney(r.impact), num: true },
    { label: '未结影响', render: (r) => fmtMoney(r.open_impact), num: true },
  ], s.by_type);
  buildTable($('#table-by-stage'), [
    { label: '责任环节', key: 'label' },
    { label: '异常数', key: 'cnt', num: true },
    { label: '影响金额合计', render: (r) => fmtMoney(r.impact), num: true },
  ], s.by_stage);

  buildTable($('#table-runs'), [
    { label: '运行', render: (r) => `#${r.id}` },
    { label: '时间', render: (r) => fmtTime(r.ran_at) },
    { label: '范围', render: (r) => (r.supplier_id ? `供应商#${r.supplier_id}` : '全部供应商') },
    { label: '匹配链接', key: 'link_count', num: true },
    { label: '新增异常', key: 'anomaly_count', num: true },
  ], s.runs);
}

/* ---------- 匹配过程 ---------- */
async function renderMatching() {
  const runs = await api('/api/matching/runs');
  const sel = $('#sel-run');
  clear(sel);
  for (const r of runs) {
    const opt = el('option', null, `#${r.id} · ${fmtTime(r.ran_at)} · 异常 ${r.anomaly_count}`);
    opt.value = r.id;
    sel.append(opt);
  }
  if (runs.length) await renderTrace(runs[0].id);
  else buildTable($('#table-trace'), [{ label: '提示', key: 'x' }], [{ x: '尚未运行匹配' }]);
}

async function renderTrace(runId) {
  const data = await api(`/api/matching/runs/${runId}/trace`);
  $('#run-meta').textContent = `共 ${data.links.length} 条分配记录`;
  buildTable($('#table-trace'), [
    { label: '发票', key: 'invoice_no' },
    { label: 'SKU', key: 'sku' },
    { label: '开票数量', key: 'invoiced_qty', num: true, render: (r) => fmtQty(r.invoiced_qty) },
    { label: '单价', num: true, render: (r) => fmtMoney(r.unit_price) },
    { label: 'PO', render: (r) => (r.po_no ? `${r.po_no}#${r.po_line_no}` : '-') },
    { label: '收货单', render: (r) => r.grn_no || '-' },
    { label: '本次核销', key: 'allocated_qty', num: true, render: (r) => fmtQty(r.allocated_qty) },
    { label: '状态', render: (r) => badge(MATCH_STATUS[r.match_status]) },
  ], data.links);
}

/* ---------- 异常分类 ---------- */
async function renderAnomalies() {
  const params = new URLSearchParams();
  const type = $('#flt-type').value;
  const status = $('#flt-status').value;
  if (type) params.set('type', type);
  if (status) params.set('status', status);
  const supplier = $('#flt-supplier').value;
  if (supplier) params.set('supplier_id', supplier);
  let rows = await api(`/api/anomalies?${params}`);
  const stage = $('#flt-stage').value;
  if (stage) rows = rows.filter((r) => r.responsible_stage === stage);

  const typeLabel = Object.fromEntries(META.anomaly_types.map((t) => [t.value, t.label]));
  const stageLabel = Object.fromEntries(META.stages.map((t) => [t.value, t.label]));
  buildTable($('#table-anomalies'), [
    { label: 'ID', render: (r) => `#${r.id}` },
    { label: '类型', render: (r) => typeLabel[r.type] || r.type },
    { label: '严重度', render: (r) => badge(SEV[r.severity]) },
    { label: '供应商', render: (r) => `${r.supplier_code} ${r.supplier_name}` },
    { label: '发票', render: (r) => r.invoice_no || '-' },
    { label: '期间', key: 'period' },
    { label: '责任环节', render: (r) => stageLabel[r.responsible_stage] || r.responsible_stage },
    { label: '影响金额', num: true, render: (r) => fmtMoney(r.impact_amount) },
    { label: '状态', render: (r) => badge(STATUS[r.status]) },
  ], rows, { onRow: (r) => openAnomalyDrawer(r.id) });
}

async function openAnomalyDrawer(id) {
  const a = await api(`/api/anomalies/${id}`);
  const body = $('#drawer-body');
  clear(body);
  const typeLabel = Object.fromEntries(META.anomaly_types.map((t) => [t.value, t.label]));
  const stageLabel = Object.fromEntries(META.stages.map((t) => [t.value, t.label]));

  body.append(el('h3', null, `异常 #${a.id} · ${typeLabel[a.type] || a.type}`));
  const meta = el('p', 'muted');
  meta.textContent = `${a.supplier_code} ${a.supplier_name} · 期间 ${a.period} · 责任环节：${stageLabel[a.responsible_stage] || a.responsible_stage}`;
  body.append(meta);
  const badges = el('p');
  badges.append(badge(SEV[a.severity]), ' ', badge(STATUS[a.status]));
  body.append(badges);

  const impact = el('div', 'diff-box');
  impact.append(diffRow('影响金额', `¥${fmtMoney(a.impact_amount)}`));
  body.append(impact);

  // 证据链
  body.append(el('div', 'section-title', '证据链'));
  body.append(buildChain(a.evidence));

  // 差异
  if (a.evidence && a.evidence.diff) {
    body.append(el('div', 'section-title', '差异定位'));
    const box = el('div', 'diff-box');
    for (const [k, v] of Object.entries(a.evidence.diff)) {
      box.append(diffRow(diffKeyLabel(k), typeof v === 'number' ? String(v) : String(v)));
    }
    body.append(box);
  }

  // 修复动作
  if (a.status === 'open') {
    body.append(el('div', 'section-title', '发起修复'));
    const row = el('div', 'filter-row');
    const sel = el('select');
    const allowed = await allowedActions(a.type);
    for (const act of allowed) {
      const opt = el('option', null, act.label);
      opt.value = act.value;
      sel.append(opt);
    }
    const btn = el('button', 'primary', '提交修复方案');
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/anomalies/${a.id}/fixes`, {
          method: 'POST',
          body: { action: sel.value, proposed_by: 'web-user' },
        });
        toast('修复方案已提交，等待审批');
        closeDrawer();
        renderAnomalies();
      } catch (err) {
        toast(err.message);
      }
    });
    row.append(sel, btn);
    body.append(row);
  }

  // 历史修复
  if (a.fixes && a.fixes.length) {
    body.append(el('div', 'section-title', '修复记录'));
    const t = el('table');
    buildTable(t, [
      { label: '动作', key: 'action' },
      { label: '状态', render: (r) => badge(STATUS[r.status]) },
      { label: '提出', render: (r) => r.proposed_by || '-' },
      { label: '审批', render: (r) => r.approved_by || '-' },
    ], a.fixes);
    body.append(t);
  }

  $('#drawer-mask').classList.add('open');
  $('#drawer').classList.add('open');
}

function diffRow(k, v) {
  const row = el('div', 'd-row');
  row.append(el('span', 'd-k', k), el('span', 'mono', v));
  return row;
}

const DIFF_KEYS = {
  field: '差异字段', expected: '应有值', actual: '实际值',
  ordered_qty: '订单数量', received_qty: '累计收货', cum_invoiced_qty: '累计开票',
  uncovered_qty: '无收货支撑数量', pending_qty: '待收货数量',
  effective_revision: '有效价格版本', matched_old_revision: '命中旧修订价',
};
function diffKeyLabel(k) {
  return DIFF_KEYS[k] || k;
}

function buildChain(ev) {
  const chain = el('div', 'chain');
  const node = (title, lines) => {
    const n = el('div', 'node');
    n.append(el('div', 'n-title', title));
    const b = el('div', 'n-body');
    b.textContent = lines;
    n.append(b);
    return n;
  };
  if (!ev) return chain;
  if (ev.po) {
    const revs = (ev.po.revisions || [])
      .map((r) => `v${r.version_no} ${r.unit_price}元/${(r.tax_rate * 100).toFixed(0)}% 自${r.effective_from}`)
      .join('；');
    chain.append(node(`采购订单 ${ev.po.po_no}#${ev.po.line_no}`,
      `SKU ${ev.po.sku} · 订单 ${ev.po.ordered_qty} · 累计收货 ${ev.po.received_qty ?? '-'} · 修订：${revs || '无'}`));
  }
  for (const r of ev.receipts || []) {
    chain.append(node(`收货 ${r.grn_no}`, `日期 ${r.receipt_date} · 数量 ${r.qty}`));
  }
  if (ev.invoice) {
    const inv = ev.invoice;
    chain.append(node(`发票 ${inv.invoice_no}`,
      `日期 ${inv.invoice_date} · ${inv.sku ? `SKU ${inv.sku} · ` : ''}数量 ${inv.qty ?? '-'} · 单价 ${inv.unit_price ?? '-'} · 税率 ${inv.tax_rate != null ? (inv.tax_rate * 100).toFixed(0) + '%' : '-'} · 金额 ${inv.amount ?? inv.total ?? '-'}`));
  }
  if (ev.duplicate_of) {
    chain.append(node('重复于', `原发票 ${ev.duplicate_of.invoice_no} · ${ev.duplicate_of.invoice_date}`));
  }
  for (const p of ev.payments || []) {
    chain.append(node(`付款 ${p.payment_no}`, `日期 ${p.pay_date} · 金额 ${fmtMoney(p.amount)}`));
  }
  return chain;
}

async function allowedActions(type) {
  // 与后端 FIX_ACTIONS 对齐的展示映射
  const map = {
    PRICE_MISMATCH: ['adjust_to_po_price', 'dismiss'],
    TAX_RATE_CHANGE: ['accept_tax_diff', 'adjust_tax_diff', 'dismiss'],
    OVER_INVOICE_QTY: ['hold_overbilled', 'dismiss'],
    DUPLICATE_INVOICE: ['void_duplicate', 'dismiss'],
    UNMATCHED_INVOICE: ['reject_invoice', 'dismiss'],
    OVER_PAYMENT: ['refund_overpayment', 'dismiss'],
    PARTIAL_RECEIPT_PENDING: ['dismiss'],
  };
  const labels = Object.fromEntries(META.fix_actions.map((a) => [a.value, a.label]));
  return (map[type] || ['dismiss']).map((v) => ({ value: v, label: labels[v] || v }));
}

function closeDrawer() {
  $('#drawer-mask').classList.remove('open');
  $('#drawer').classList.remove('open');
}

/* ---------- 修复审批 ---------- */
async function renderFixes() {
  const fixes = await api('/api/fixes');
  const actionLabel = Object.fromEntries(META.fix_actions.map((a) => [a.value, a.label]));
  const cols = [
    { label: '单号', render: (r) => `#${r.id}` },
    { label: '异常类型', render: (r) => (META.anomaly_types.find((t) => t.value === r.anomaly_type) || {}).label || r.anomaly_type },
    { label: '供应商', render: (r) => `${r.supplier_code} ${r.supplier_name}` },
    { label: '发票', render: (r) => r.invoice_no || '-' },
    { label: '期间', key: 'anomaly_period' },
    { label: '修复动作', render: (r) => actionLabel[r.action] || r.action },
    { label: '影响金额', num: true, render: (r) => fmtMoney(r.impact_amount) },
    { label: '提出人', render: (r) => r.proposed_by || '-' },
    { label: '状态', render: (r) => badge(STATUS[r.status]) },
  ];
  const pending = fixes.filter((f) => f.status === 'pending');
  const done = fixes.filter((f) => f.status !== 'pending');

  buildTable($('#table-fixes-pending'), [
    ...cols,
    {
      label: '操作',
      render: (r) => {
        const wrap = el('span');
        const ok = el('button', 'primary', '通过');
        ok.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            const res = await api(`/api/fixes/${r.id}/approve`, { method: 'POST', body: { approved_by: 'approver' } });
            toast(`已通过：调整 ${fmtMoney(res.adjustment)} 元 → 期间 ${res.postingPeriod}，已生成新版本`);
            renderFixes();
            renderOverview();
          } catch (err) {
            toast(err.message);
          }
        });
        const no = el('button', null, '驳回');
        no.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await api(`/api/fixes/${r.id}/reject`, { method: 'POST', body: { decided_by: 'approver' } });
            toast('已驳回');
            renderFixes();
          } catch (err) {
            toast(err.message);
          }
        });
        wrap.append(ok, ' ', no);
        return wrap;
      },
    },
  ], pending);
  buildTable($('#table-fixes-done'), [
    ...cols,
    { label: '审批人', render: (r) => r.approved_by || '-' },
    { label: '处理时间', render: (r) => fmtTime(r.decided_at) },
  ], done);
}

/* ---------- 待付款清单 ---------- */
async function renderPayables() {
  const params = new URLSearchParams();
  if ($('#pay-supplier').value) params.set('supplier_id', $('#pay-supplier').value);
  if ($('#pay-period').value) params.set('period', $('#pay-period').value);
  const [payables, versions] = await Promise.all([
    api(`/api/payables?${params}`),
    api(`/api/bills/versions?${params}`),
  ]);
  buildTable($('#table-payables'), [
    { label: '供应商', render: (r) => `${r.supplier_code} ${r.supplier_name}` },
    { label: '期间', key: 'period' },
    { label: '发票', key: 'invoice_no' },
    { label: '行类型', render: (r) => (r.kind === 'adjustment' ? '跨期调整' : '发票') },
    { label: '应付金额', num: true, render: (r) => fmtMoney(r.amount_due) },
    { label: '版本', render: (r) => `v${r.version_no}` },
    { label: '版本来源', render: (r) => ({ initial: '初始', backfill: '回补重建', fix_approved: '修复审批' }[r.version_reason] || r.version_reason) },
  ], payables);
  const total = payables.reduce((s, r) => s + r.amount_due, 0);
  const tfoot = el('tfoot');
  const tr = el('tr');
  const td = el('td', null, '合计');
  td.colSpan = 4;
  tr.append(td, el('td', 'num mono', fmtMoney(total)), el('td'), el('td'));
  tfoot.append(tr);
  $('#table-payables').append(tfoot);

  buildTable($('#table-versions'), [
    { label: '供应商', render: (r) => `${r.supplier_code} ${r.supplier_name}` },
    { label: '期间', key: 'period' },
    { label: '版本', render: (r) => `v${r.version_no}` },
    { label: '来源', render: (r) => ({ initial: '初始', backfill: '回补重建', fix_approved: '修复审批' }[r.reason] || r.reason) },
    { label: '应付合计', num: true, render: (r) => fmtMoney(r.payable_total) },
    { label: '生成时间', render: (r) => fmtTime(r.created_at) },
  ], versions);
}

/* ---------- 启动 ---------- */
function fillSelect(sel, items, labelFn) {
  const first = sel.querySelector('option');
  clear(sel);
  if (first) sel.append(first);
  for (const it of items) {
    const opt = el('option', null, labelFn(it));
    opt.value = it.value ?? it.id;
    sel.append(opt);
  }
}

async function boot() {
  META = await api('/api/meta');
  fillSelect($('#flt-type'), META.anomaly_types, (t) => t.label);
  fillSelect($('#flt-stage'), META.stages, (t) => t.label);
  fillSelect($('#flt-supplier'), META.suppliers, (s) => `${s.code} ${s.name}`);
  fillSelect($('#pay-supplier'), META.suppliers, (s) => `${s.code} ${s.name}`);
  fillSelect($('#pay-period'), META.periods.map((p) => ({ value: p.period, label: `${p.period}（${p.status === 'open' ? '开放' : '关闭'}）` })), (p) => p.label);

  await renderOverview();

  document.querySelectorAll('nav.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      btn.classList.add('active');
      $(`#view-${btn.dataset.view}`).classList.add('active');
      ({ overview: renderOverview, matching: renderMatching, anomalies: renderAnomalies, fixes: renderFixes, payables: renderPayables })[btn.dataset.view]();
    });
  });

  $('#btn-run-matching').addEventListener('click', async () => {
    try {
      const r = await api('/api/matching/run', { method: 'POST', body: {} });
      toast(`匹配完成：${r.links} 条核销链接，新增 ${r.anomalies} 条异常`);
      renderOverview();
    } catch (err) {
      toast(err.message);
    }
  });

  $('#sel-run').addEventListener('change', (e) => renderTrace(e.target.value));
  for (const id of ['#flt-type', '#flt-stage', '#flt-status', '#flt-supplier']) {
    $(id).addEventListener('change', renderAnomalies);
  }
  for (const id of ['#pay-supplier', '#pay-period']) {
    $(id).addEventListener('change', renderPayables);
  }
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-mask').addEventListener('click', closeDrawer);

  // 主题：跟随系统 + 手动切换（data-theme 优先）
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#btn-theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
  });
}

boot().catch((err) => toast(err.message));
