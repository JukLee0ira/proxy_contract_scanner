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
        console.error('[xdcBootstrap] ❌ Environment variable XDC_META_DB_URL is not set, cannot connect to XDC metadata database.');
        console.error('[xdcBootstrap] Example:');
        console.error('  XDC_META_DB_URL=postgres://user:pass@host:5432/xdc_transactions \\');
        console.error('    SCANNER_API_URL=http://localhost:3000 \\');
        console.error('    npx ts-node scripts/xdcBootstrap.ts --dry-run');
        process.exit(2);
    }

    console.log('[xdcBootstrap] ▶️ Starting XDC metadata bootstrap script (demo config check stage)');
    console.log(`[xdcBootstrap] - XDC_META_DB_URL: ${metaDbUrl}`);
    console.log(`[xdcBootstrap] - SCANNER_API_URL: ${apiUrl}`);
    console.log(`[xdcBootstrap] - XDC_CHAIN_ID : ${chainId ?? '(not limited, will scan whole table or by condition later)'}`);

    // 解析命令行参数（例如 --dry-run）
    const args = process.argv.slice(2).map(s => s.trim()).filter(Boolean);
    const isDryRun = args.includes('--dry-run') || args.includes('-n');

    // 1) Try connecting to the XDC metadata database once, perform a simple query only (no real data fetch to avoid mis-operations)
    const metaPool = new Pool({ connectionString: metaDbUrl });
    try {
        console.log('[xdcBootstrap] 🧪 Testing connection to XDC metadata database...');
        const client = await metaPool.connect();
        try {
            // NOTE: Using your existing contracts directory table `contracts`
            const testSql = 'SELECT COUNT(1) AS cnt FROM contracts;';
            const res = await client.query(testSql);
            const cnt = (res.rows[0] && Number(res.rows[0].cnt)) || 0;
            console.log(`[xdcBootstrap] ✅ Connection successful, current row count of table contracts: ${cnt}`);
        } finally {
            client.release();
        }
    } catch (e) {
        console.error('[xdcBootstrap] ❌ Failed to connect to or query XDC metadata database:', e instanceof Error ? e.message : String(e));
        await metaPool.end().catch(() => undefined);
        process.exit(1);
    }

    // 2) Test whether HTTP API /status is available (verify scanner + API are running)
    try {
        console.log('[xdcBootstrap] 🧪 Testing Scanner HTTP API /status ...');
        const resp = await axios.get(`${apiUrl}/status`, { timeout: 5000 });
        console.log('[xdcBootstrap] ✅ /status response summary:', {
            db: resp.data?.db,
            listener: resp.data?.listener,
            storageMonitor: resp.data?.storageMonitor,
        });
    } catch (e) {
        console.error('[xdcBootstrap] ⚠️ Cannot access Scanner HTTP API /status, please confirm scanner is running:', e instanceof Error ? e.message : String(e));
        console.error('[xdcBootstrap]  Example start command (for reference):');
        console.error('    MODE=listen-analyze RPC_URL=... DB_HOST=... DB_NAME=... \\');
        console.error('      npx ts-node src/index.ts');
    }

    if (isDryRun) {
        console.log('[xdcBootstrap] 💡 Running in --dry-run mode, only checking configuration and connectivity, will not pull addresses or call /monitor.');
    } else {
        // 3) Demo: fetch a small batch of addresses from table `contracts`, print them,
        //    and call /monitor for the first few to go through the existing pipeline
        try {
            console.log('[xdcBootstrap] 🧪 Fetching sample contract addresses (from contracts, LIMIT 10)...');
            const client = await metaPool.connect();
            try {
                // NOTE: Some columns in table `contracts` use camelCase (chainId / isProxy / similarMatch / lastProxyCheck / lastSeenAt),
                //       you must use double quotes to reference them precisely in PostgreSQL.
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
                    console.log('[xdcBootstrap] ⚠️ No records in table contracts (or query returned empty).');
                } else {
                    console.log('[xdcBootstrap] ✅ Sample address list (up to 10 rows):');
                    for (const row of res.rows) {
                        console.log(
                            `  - address=${row.address} chainId=${row.chainId} ` +
                            `isProxy=${row.isProxy} implementation=${row.implementation} ` +
                            `similarMatch=${row.similarMatch} lastProxyCheck=${row.lastProxyCheck} ` +
                            `lastSeenAt=${row.lastSeenAt}`
                        );
                    }

                    // Only call /monitor for addresses with proxy signal to avoid monitoring lots of obvious non-proxy addresses
                    const candidates = res.rows.filter((row: any) => row.isProxy === true);
                    const maxMonitor = 5;
                    if (!candidates.length) {
                        console.log('[xdcBootstrap] ⚠️ 本批示例地址中没有 isProxy=true 的记录，暂不调用 /monitor。');
                    } else {
                        const toUse = candidates.slice(0, maxMonitor);
                        console.log(`[xdcBootstrap] 🚀 Preparing to inject ${toUse.length} addresses with isProxy=true into scanner pipeline via /monitor...`);
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
                                console.log('[xdcBootstrap] ✅ /monitor response:', resp.data);
                            } catch (e) {
                                console.error(
                                    `[xdcBootstrap] ❌ /monitor failed for address=${addr}:`,
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
                '[xdcBootstrap] ❌ Failed to fetch sample addresses from contracts:',
                e instanceof Error ? e.message : String(e)
            );
        }

        console.log('[xdcBootstrap] ℹ️ In non --dry-run mode, this version will: 1) fetch and print a sample batch of addresses; 2) call /monitor for the first few addresses to send into the existing pipeline.');
    }

    await metaPool.end().catch(() => undefined);
}

main().catch((e) => {
    console.error('[xdcBootstrap] Unexpected error while running xdcBootstrap:', e instanceof Error ? e.message : String(e));
    process.exit(1);
});


