// 演示数据：覆盖拆单、部分收货、价格修订、税率变化、重复发票、超额付款、跨期
import { openDb } from '../src/db.js';
import { buildFixture } from '../test-utils/helpers.js';
import { runMatching } from '../src/matching.js';

const dbPath = process.env.DB_PATH || new URL('../data.sqlite', import.meta.url).pathname;
const db = openDb(dbPath);

const has = db.prepare('SELECT COUNT(*) AS c FROM suppliers').get().c > 0;
if (has) {
  console.log('数据库已有数据，跳过种子（如需重建请删除 data.sqlite）');
} else {
  buildFixture(db);
  const r = runMatching(db, { note: '种子数据初始匹配' });
  console.log(`种子完成：${dbPath}`);
  console.log(`匹配运行 #${r.runId}：${r.links} 条核销链接，${r.anomalies} 条异常`);
}
db.close();
