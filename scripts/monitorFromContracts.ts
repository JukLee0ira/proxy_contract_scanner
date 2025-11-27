import { Pool } from 'pg';
import axios from 'axios';

/**
 * 从 contracts 表批量读取合约地址，并通过 HTTP /monitor 注入到现有扫描管线：
 * contracts -> /monitor -> proxy_contracts -> 安全检测 -> Telegram 等告警
 *
 * 关键点：
 * - 这里只从 contracts 表「只拿 address」字段，不再依赖 implementation / isProxy 等列做预过滤
 * - 复用 src/demo/proxyScannerDemo.ts 通过 /monitor 暴露出来的完整业务逻辑
 */
async function main() {
    const metaDbUrl =
        process.env.XDC_META_DB_URL ||
        process.env.BATCH_DB_URL ||
        process.env.DATABASE_URL;
    const apiUrl =
        process.env.XDC_SCANNER_API_URL ||
        process.env.API_URL ||
        'http://localhost:3000';

    if (!metaDbUrl) {
        console.error('[monitorFromContracts] ❌ Metadata DB URL is not configured (XDC_META_DB_URL / BATCH_DB_URL / DATABASE_URL).');
        process.exit(2);
    }

    console.log('[monitorFromContracts] ▶️ Start feeding addresses from contracts into scanner /monitor pipeline.');
    console.log(`[monitorFromContracts] - META_DB_URL : ${metaDbUrl}`);
    console.log(`[monitorFromContracts] - API_URL     : ${apiUrl}`);

    const pool = new Pool({ connectionString: metaDbUrl });

    // 批量大小可通过环境变量控制，默认每批 100 条地址
    const batchSize = parseInt(process.env.CONTRACTS_BATCH_SIZE || '100', 10);

    let offset = 0;
    let totalSent = 0;

    try {
        // 简单的分页扫描：按 lastSeenAt 倒序，每批 LIMIT + OFFSET
        while (true) {
            const client = await pool.connect();
            let rows: { address: string }[] = [];
            try {
                const sql = `
                    SELECT
                        address
                    FROM contracts
                    ORDER BY "lastSeenAt" DESC NULLS LAST
                    LIMIT $1 OFFSET $2
                `;
                const res = await client.query(sql, [batchSize, offset]);
                rows = res.rows;
            } catch (e: any) {
                console.error('[monitorFromContracts] ❌ Failed to read from contracts:', e.message || String(e));
                throw e;
            } finally {
                client.release();
            }

            if (!rows.length) {
                console.log('[monitorFromContracts] 🎉 No more rows from contracts, stop feeding.');
                break;
            }

            console.log(`[monitorFromContracts] ✅ Fetched ${rows.length} addresses from contracts (offset=${offset}).`);

            // 逐个地址调用 /monitor，将后续“是否代理 + 写 proxy_contracts + 安全检测 + alert”的逻辑
            // 完全交给现有 HTTP API 与 proxyScannerDemo.ts 来处理。
            for (const row of rows) {
                const addr = String(row.address || '').trim();
                if (!addr) continue;
                try {
                    const resp = await axios.post(
                        `${apiUrl}/monitor`,
                        { address: addr },
                        { timeout: 15000 }
                    );
                    if ((resp.data as any)?.ok) {
                        totalSent++;
                        console.log(`[monitorFromContracts] ▶️ /monitor accepted address=${addr}`);
                    } else {
                        console.warn(
                            `[monitorFromContracts] ⚠️ /monitor responded without ok for address=${addr}:`,
                            resp.data
                        );
                    }
                } catch (e: any) {
                    console.error(
                        `[monitorFromContracts] ❌ /monitor failed for address=${addr}:`,
                        e instanceof Error ? e.message : String(e)
                    );
                }
            }

            offset += rows.length;
        }
    } finally {
        await pool.end().catch(() => undefined);
    }

    console.log('[monitorFromContracts] ✅ Completed feeding addresses into /monitor pipeline:', {
        totalSent,
    });
}

main().catch((e: any) => {
    console.error('[monitorFromContracts] Runtime error:', e.message || String(e));
    process.exit(1);
});


