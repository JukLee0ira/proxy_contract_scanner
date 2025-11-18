import { Pool } from 'pg';
import axios from 'axios';

/**
 * XDC 元数据批量引导脚本
 *
 * 目标（第一步 demo 版）：
 * - 读取环境变量，确认：
 *   - XDC 元数据库连接串（XDC_META_DB_URL）
 *   - 目标链 ID（XDC_CHAIN_ID，可选）
 *   - 已运行的 HTTP API 入口地址（SCANNER_API_URL，默认为 http://localhost:3000）
 * - 不真正扫描，只打印配置与连接测试结果，供你确认方向是否正确
 */

async function main() {
    const metaDbUrl = process.env.XDC_META_DB_URL;
    const apiUrl = process.env.SCANNER_API_URL || 'http://localhost:3000';
    const chainId = process.env.XDC_CHAIN_ID ? parseInt(process.env.XDC_CHAIN_ID, 10) : undefined;

    if (!metaDbUrl) {
        console.error('[xdcBootstrap] ❌ 环境变量 XDC_META_DB_URL 未设置，无法连接 XDC 元数据表。');
        console.error('[xdcBootstrap] 示例：');
        console.error('  XDC_META_DB_URL=postgres://user:pass@host:5432/xdc_transactions \\');
        console.error('    SCANNER_API_URL=http://localhost:3000 \\');
        console.error('    npx ts-node scripts/xdcBootstrap.ts --dry-run');
        process.exit(2);
    }

    console.log('[xdcBootstrap] ▶️ 启动 XDC 元数据批量引导脚本（demo 配置检查阶段）');
    console.log(`[xdcBootstrap] - XDC_META_DB_URL: ${metaDbUrl}`);
    console.log(`[xdcBootstrap] - SCANNER_API_URL: ${apiUrl}`);
    console.log(`[xdcBootstrap] - XDC_CHAIN_ID : ${chainId ?? '(未限定，后续将全表或按条件扫描)'}`);

    // 解析命令行参数（例如 --dry-run）
    const args = process.argv.slice(2).map(s => s.trim()).filter(Boolean);
    const isDryRun = args.includes('--dry-run') || args.includes('-n');

    // 1) 尝试连一次 XDC 元数据库，只做简单查询（不取真实数据，防止误操作）
    const metaPool = new Pool({ connectionString: metaDbUrl });
    try {
        console.log('[xdcBootstrap] 🧪 正在测试连接 XDC 元数据数据库...');
        const client = await metaPool.connect();
        try {
            // 注意：这里使用的是你已有的合约目录表 contracts
            const testSql = 'SELECT COUNT(1) AS cnt FROM contracts;';
            const res = await client.query(testSql);
            const cnt = (res.rows[0] && Number(res.rows[0].cnt)) || 0;
            console.log(`[xdcBootstrap] ✅ 连接成功，表 contracts 当前行数约为: ${cnt}`);
        } finally {
            client.release();
        }
    } catch (e) {
        console.error('[xdcBootstrap] ❌ 连接或测试查询 XDC 元数据数据库失败：', e instanceof Error ? e.message : String(e));
        await metaPool.end().catch(() => undefined);
        process.exit(1);
    }

    // 2) 测试 HTTP API /status 是否可用（验证 scanner + API 是否已启动）
    try {
        console.log('[xdcBootstrap] 🧪 正在测试连接 Scanner HTTP API /status ...');
        const resp = await axios.get(`${apiUrl}/status`, { timeout: 5000 });
        console.log('[xdcBootstrap] ✅ /status 返回结果简要：', {
            db: resp.data?.db,
            listener: resp.data?.listener,
            storageMonitor: resp.data?.storageMonitor,
        });
    } catch (e) {
        console.error('[xdcBootstrap] ⚠️ 无法访问 Scanner HTTP API /status，请确认 scanner 是否已运行：', e instanceof Error ? e.message : String(e));
        console.error('[xdcBootstrap]  示例启动命令（供参考）：');
        console.error('    MODE=listen-analyze RPC_URL=... DB_HOST=... DB_NAME=... \\');
        console.error('      npx ts-node src/index.ts');
    }

    if (isDryRun) {
        console.log('[xdcBootstrap] 💡 当前为 --dry-run 模式，只做配置与连通性检查，不会真正拉取地址或调用 /monitor。');
    } else {
        // 3) demo：从 contracts 表中拉取一小批地址，打印出来，并对前若干条调用 /monitor 走入现有管线
        try {
            console.log('[xdcBootstrap] 🧪 拉取示例合约地址（来自 contracts，LIMIT 10）...');
            const client = await metaPool.connect();
            try {
                // 注意：contracts 表中的部分列是驼峰形式（chainId / isProxy / similarMatch / lastProxyCheck / lastSeenAt），
                // 在 PostgreSQL 中需要使用双引号精确引用。
                const sampleSql = `
                    SELECT
                        address,
                        "chainId",
                        "isProxy",
                        implementation,
                        "similarMatch",
                        "lastProxyCheck",
                        "lastSeenAt"
                    FROM contracts
                    WHERE "isProxy" = true
                    ORDER BY "lastSeenAt" DESC NULLS LAST
                    LIMIT 10;
                `;
                const res = await client.query(sampleSql);
                if (!res.rows.length) {
                    console.log('[xdcBootstrap] ⚠️ contracts 表中没有任何记录（或查询结果为空）。');
                } else {
                    console.log('[xdcBootstrap] ✅ 示例地址列表（最多 10 条）：');
                    for (const row of res.rows) {
                        console.log(
                            `  - address=${row.address} chainId=${row.chainId} ` +
                            `isProxy=${row.isProxy} implementation=${row.implementation} ` +
                            `similarMatch=${row.similarMatch} lastProxyCheck=${row.lastProxyCheck} ` +
                            `lastSeenAt=${row.lastSeenAt}`
                        );
                    }

                    // 只对“有代理信号”的地址调用 /monitor，避免把大量明显非代理的地址挂成监控
                    const candidates = res.rows.filter((row: any) => row.isProxy === true);
                    const maxMonitor = 5;
                    if (!candidates.length) {
                        console.log('[xdcBootstrap] ⚠️ 本批示例地址中没有 isProxy=true 的记录，暂不调用 /monitor。');
                    } else {
                        const toUse = candidates.slice(0, maxMonitor);
                        console.log(`[xdcBootstrap] 🚀 准备通过 /monitor 注入 ${toUse.length} 个 isProxy=true 的地址到 scanner 管线...`);
                        for (const row of toUse) {
                            const addr = String(row.address).trim();
                            if (!addr) continue;
                            try {
                                console.log(`[xdcBootstrap] ▶️ /monitor address=${addr} (isProxy=${row.isProxy}, implementation=${row.implementation})`);
                                const resp = await axios.post(
                                    `${apiUrl}/monitor`,
                                    { address: addr },
                                    { timeout: 10000 }
                                );
                                console.log('[xdcBootstrap] ✅ /monitor 返回：', resp.data);
                            } catch (e) {
                                console.error(
                                    `[xdcBootstrap] ❌ /monitor 失败 address=${addr}:`,
                                    e instanceof Error ? e.message : String(e)
                                );
                            }
                        }
                    }
                }
            } finally {
                client.release();
            }
        } catch (e) {
            console.error(
                '[xdcBootstrap] ❌ 从 contracts 拉取示例地址失败：',
                e instanceof Error ? e.message : String(e)
            );
        }

        console.log('[xdcBootstrap] ℹ️ 当前版本在非 --dry-run 模式下会：1）拉取一批示例地址并打印；2）对前若干个地址调用 /monitor 送入现有管线。');
    }

    await metaPool.end().catch(() => undefined);
}

main().catch((e) => {
    console.error('[xdcBootstrap] 运行出错：', e instanceof Error ? e.message : String(e));
    process.exit(1);
});


