# 供应商账单异常分析系统

融合采购订单、收货、发票、付款四类单据，自动完成三单匹配，把异常定位到**证据链**和**责任环节**；修复审批通过后生成**新账单版本**并原子同步**待付款清单**。零外部依赖（Node ≥ 22.5，内置 `node:http` + `node:sqlite`）。

## 快速开始

```bash
npm run seed    # 生成演示数据（覆盖全部异常场景）到 data.sqlite
npm start       # 启动服务 http://localhost:3000（DB_PATH/PORT 可覆盖）
npm test        # 18 个测试：匹配引擎 / 并发回补幂等 / 修复审批与跨期
```

页面五个页签：**概览**（影响金额图表）、**匹配过程**（核销明细）、**异常分类**（证据链抽屉）、**修复审批**（通过/驳回）、**待付款清单**（版本历史）。

## 业务场景处理

| 场景 | 机制 |
|---|---|
| 拆单 | 一张 PO 行可被多张发票拆分核销，按发票日期 FIFO 聚合比对累计量 |
| 部分收货 | 收货行按日期 FIFO 被发票逐笔核销，剩余量跨期等待后续收货 |
| 价格修订 | `po_price_revisions` 保存完整修订史，按**发票日期**取有效价比对；发票价命中旧修订价 → 责任判定为采购未同步 |
| 税率变化 | 发票税率 ≠ 有效约定税率 → 税额差计入影响金额，责任环节为税务政策 |
| 重复发票 | 同号：入账时唯一约束拦截（409）；换号重开：内容指纹（供应商+日期+金额+明细）检出 |
| 跨期 | 异常归属发票期间；期间已关闭时调整分录落在**最近开放期间**，两个期间各自生成新版本 |
| 来源回补 | `ingest_log(source_type, source_key)` 幂等台账 + 唯一约束兜底：重复回补去重、内容冲突 409、并发只入账一次，且去重的回补不生成新版本 |

## 异常分类与责任环节

`PRICE_MISMATCH`(价格差异) / `TAX_RATE_CHANGE`(税率变化) / `OVER_INVOICE_QTY`(超量开票) / `DUPLICATE_INVOICE`(重复发票) / `UNMATCHED_INVOICE`(无订单发票) / `OVER_PAYMENT`(超额付款) / `PARTIAL_RECEIPT_PENDING`(部分收货待齐，提示性)

责任环节：采购定价 purchasing / 仓储收货 warehouse / 供应商开票 vendor_billing / 财务付款 finance / 税务政策 tax_policy。每条异常携带证据链快照（PO→修订史→收货→发票→付款+差异字段），重复运行按 `dedupe_key` 幂等，不重复生成。

## 修复审批 → 版本 → 待付款

1. 异常上发起修复方案（每异常同时仅一个待审批，部分唯一索引保证）；
2. 审批通过（条件更新防并发双批）→ 写调整分录（`UNIQUE(fix_id)` 防重复入账）→ 异常关闭 → 相关期间各生成新 `bill_versions` → 同事务整体替换 `payable_list`；
3. 作废类动作（`void_duplicate`/`reject_invoice`）同步作废发票，后续匹配不再检出。

## 目录结构

```
src/db.js        schema、事务、期间规则
src/ingest.js    单据入账（幂等回补）
src/matching.js  三单匹配引擎 + 异常检测 + 证据链
src/fixes.js     修复方案 / 审批（调整分录 + 版本生成）
src/billing.js   账单版本生成 + 待付款清单同步
src/queries.js   查询接口
src/server.js    HTTP API + 静态页面
public/          单页应用（原生 JS，图表遵循 dataviz 规范）
test/            node:test 测试（test-utils/helpers.js 为共享夹具）
scripts/seed.js  演示数据
```

## API 摘要

- `POST /api/ingest/:type`（po | price_revision | receipt | invoice | payment）
- `POST /api/matching/run`、`GET /api/matching/runs/:id/trace`
- `GET /api/anomalies`、`GET /api/anomalies/:id`（证据链）、`POST /api/anomalies/:id/fixes`
- `POST /api/fixes/:id/approve|reject`
- `GET /api/payables`、`GET /api/bills/versions`、`GET /api/summary`
- `POST /api/periods/:period/close|open`（跨期验证）
