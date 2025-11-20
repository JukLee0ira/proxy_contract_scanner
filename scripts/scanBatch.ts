import { Pool } from 'pg';
import { ethers } from 'ethers';
import { analyzeContract } from '../src/services/analyzer';
import { runPairDetectors } from '../src/detectors/pair';
import { HelloPairDetector } from '../src/detectors/pair/helloPair';
import { UpgradeGovernancePairDetector } from '../src/detectors/pair/upgradeGovernance';
import { StorageCollisionPairDetector } from '../src/detectors/pair/storageCollision';
import { InitializerMistakesPairDetector } from '../src/detectors/pair/initializerMistakes';
import { MixingPatternsPairDetector } from '../src/detectors/pair/mixingPatterns';
import { LibraryMisusePairDetector } from '../src/detectors/pair/libraryMisuse';
import { getVerifiedSource } from '../src/clients/etherscan';
import { isTelegramEnabled, sendTelegramAlert } from '../src/alert/telegram';

type Severity = 'NONE' | 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH';

type RiskRow = {
    address: string;
    upgrade_governance_risk: Severity;
    storage_collision_risk: Severity;
    initializer_exposure_risk: Severity;
    mixing_patterns_risk: Severity;
    library_misuse_risk: Severity;
    raw_report: any;
};

const SEV_ORDER: Severity[] = ['NONE', 'INFO', 'LOW', 'MEDIUM', 'HIGH'];

function maxSeverity(a: Severity, b: Severity): Severity {
    return SEV_ORDER.indexOf(b) > SEV_ORDER.indexOf(a) ? b : a;
}

function normalizeSeverity(raw: any): Severity {
    const v = String(raw || '').toLowerCase();
    if (v === 'high' || v === 'critical') return 'HIGH';
    if (v === 'medium') return 'MEDIUM';
    if (v === 'low') return 'LOW';
    if (v === 'info' || v === 'information') return 'INFO';
    return 'INFO';
}

function classifyFinding(f: any): {
    upgrade?: boolean;
    storage?: boolean;
    initializer?: boolean;
    mixing?: boolean;
    library?: boolean;
} {
    const id = String(f.id || '').toLowerCase();
    const title = String(f.title || '').toLowerCase();
    const text = id + ' ' + title;

    return {
        upgrade:
            text.includes('admin-privilege') ||
            text.includes('upgrade-governance') ||
            text.includes('upgrade access control') ||
            text.includes('admin access'),
        storage:
            text.includes('storage-collision') ||
            text.includes('storage collision'),
        initializer:
            text.includes('uninitialized') ||
            text.includes('initializer') ||
            text.includes('initialize'),
        mixing:
            text.includes('mixing-patterns') ||
            text.includes('mixing_patterns'),
        library:
            text.includes('library-misuse') ||
            text.includes('library_misuse'),
    };
}

async function analyzeOrFetch(address: string): Promise<{ slither: any; sources?: Record<string, string> }> {
    console.log(`[batch] analyzeContract -> ${address.toLowerCase()}`);
    try {
        const analysis = await analyzeContract(address);
        if (analysis.status === 'completed' && analysis.parsed) {
            const srcCount = analysis.sources ? Object.keys(analysis.sources).length : 0;
            const nonEmpty = analysis.sources ? Object.values(analysis.sources).filter((c: string) => (c || '').trim().length > 0).length : 0;
            console.log(`[batch] Slither OK for ${address.toLowerCase()} | sources=${srcCount} nonEmpty=${nonEmpty}`);
            return { slither: analysis.parsed, sources: analysis.sources };
        }
        console.warn(`[batch] Slither FAILED for ${address.toLowerCase()} | reason=${(analysis as any)?.rawOutput || 'no_json'} | falling back to explorer`);
    } catch (e: any) {
        console.warn(`[batch] analyzeContract threw for ${address.toLowerCase()} | ${e?.message || String(e)}`);
    }

    try {
        const verified = await getVerifiedSource(address);
        const srcCount = Object.keys(verified.sources || {}).length;
        const nonEmpty = Object.values(verified.sources || {}).filter((c: string) => (c || '').trim().length > 0).length;
        console.log(`[batch] Explorer source fetched for ${address.toLowerCase()} | files=${srcCount} nonEmpty=${nonEmpty}`);
        return { slither: {}, sources: verified.sources };
    } catch (e: any) {
        console.error(`[batch] Explorer source fetch FAILED for ${address.toLowerCase()} | ${e?.message || String(e)}`);
        throw e;
    }
}

async function buildPairContext(proxy: string, logic: string): Promise<{ ctx: any; used: 'sources' | 'bytecode' } | null> {
    // First try to build context based on verified sources
    try {
        const [proxyData, logicData] = await Promise.all([
            analyzeOrFetch(proxy),
            analyzeOrFetch(logic),
        ]);
        const proxyNonEmpty = proxyData.sources ? Object.values(proxyData.sources).filter((c: string) => (c || '').trim().length > 0).length : 0;
        const logicNonEmpty = logicData.sources ? Object.values(logicData.sources).filter((c: string) => (c || '').trim().length > 0).length : 0;
        console.log(`[batch] Prepared contexts | proxy{ nonEmpty=${proxyNonEmpty} } | logic{ nonEmpty=${logicNonEmpty} }`);
        if (proxyNonEmpty > 0 && logicNonEmpty > 0) {
            return {
                ctx: {
                    proxy: { address: proxy.toLowerCase(), slither: proxyData.slither, sources: proxyData.sources },
                    logic: { address: logic.toLowerCase(), slither: logicData.slither, sources: logicData.sources },
                },
                used: 'sources',
            };
        }
        console.warn('[batch] One or both contracts lack non-empty sources; falling back to bytecode context.');
    } catch {
        // ignore and fallback to bytecode
    }

    // Fallback to bytecode-based context
    const rpcUrl = process.env.RPC_URL || process.env.ETH_RPC_URL || 'http://localhost:8547';
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const [proxyCode, logicCode] = await Promise.all([
        provider.getCode(proxy),
        provider.getCode(logic),
    ]);
    if (!proxyCode || proxyCode === '0x') {
        console.error('[batch] No bytecode at proxy address, skipping.');
        return null;
    }
    if (!logicCode || logicCode === '0x') {
        console.error('[batch] No bytecode at logic address, skipping.');
        return null;
    }
    console.log('[batch] Using bytecode context (NO_SOURCE path).');
    return {
        ctx: {
            proxy: { address: proxy.toLowerCase(), slither: {}, bytecode: proxyCode },
            logic: { address: logic.toLowerCase(), slither: {}, bytecode: logicCode },
        },
        used: 'bytecode',
    };
}

async function analyzePair(proxy: string, logic: string): Promise<RiskRow | null> {
    console.log(`[batch] Starting pair analysis proxy=${proxy.toLowerCase()} logic=${logic.toLowerCase()}`);
    const built = await buildPairContext(proxy, logic);
    if (!built) {
        console.log('[batch] Skipped pair: no valid sources/bytecode context.');
        return null;
    }

    const registry: Record<string, any> = {
        'hello-pair': HelloPairDetector,
        'upgrade-governance': UpgradeGovernancePairDetector,
        'storage-collision': StorageCollisionPairDetector,
        'initializer_mistakes': InitializerMistakesPairDetector,
        'mixing_patterns': MixingPatternsPairDetector,
        // library-misuse: 单一入口；内部优先源码分析，缺源码时自动降级为 NO_SOURCE/bytecode 分析
        'library_misuse': LibraryMisusePairDetector,
        'library-misuse': LibraryMisusePairDetector,
    };
    // 去重，避免相同 detector 通过多个 key 出现多次
    const detectors = Array.from(new Set(Object.values(registry)));
    console.log(`[batch] Detectors selected: ${detectors.map((d: any) => d.name || 'unknown').join(', ')}`);

    const findings = await runPairDetectors(built.ctx, detectors as any);

    const risks: RiskRow = {
        address: proxy.toLowerCase(),
        upgrade_governance_risk: 'NONE',
        storage_collision_risk: 'NONE',
        initializer_exposure_risk: 'NONE',
        mixing_patterns_risk: 'NONE',
        library_misuse_risk: 'NONE',
        raw_report: { proxy: proxy.toLowerCase(), logic: logic.toLowerCase(), sourceMode: built.used, findings },
    };

    for (const f of findings || []) {
        const sev = normalizeSeverity(f.severity);
        const cat = classifyFinding(f);

        if (cat.upgrade) {
            risks.upgrade_governance_risk = maxSeverity(risks.upgrade_governance_risk, sev);
        }
        if (cat.storage) {
            risks.storage_collision_risk = maxSeverity(risks.storage_collision_risk, sev);
        }
        if (cat.initializer) {
            risks.initializer_exposure_risk = maxSeverity(risks.initializer_exposure_risk, sev);
        }
        if (cat.mixing) {
            risks.mixing_patterns_risk = maxSeverity(risks.mixing_patterns_risk, sev);
        }
        if (cat.library) {
            risks.library_misuse_risk = maxSeverity(risks.library_misuse_risk, sev);
        }
    }

    console.log('[batch] Aggregated risks:', {
        address: risks.address,
        upgrade_governance_risk: risks.upgrade_governance_risk,
        storage_collision_risk: risks.storage_collision_risk,
        initializer_exposure_risk: risks.initializer_exposure_risk,
        mixing_patterns_risk: risks.mixing_patterns_risk,
        library_misuse_risk: risks.library_misuse_risk,
    });

    return risks;
}

async function main() {
    const metaDbUrl = process.env.XDC_META_DB_URL || process.env.BATCH_DB_URL || process.env.DATABASE_URL;
    if (!metaDbUrl) {
        console.error('[batch] ❌ Batch scan database URL is not configured (XDC_META_DB_URL / BATCH_DB_URL / DATABASE_URL).');
        console.error('[batch] Example:');
        console.error('  XDC_META_DB_URL=postgres://user:pass@host:5432/xdc_transactions \\');
        console.error('    RPC_URL=https://erpc.apothem.network/ \\');
        console.error('    npx ts-node scripts/scanBatch.ts');
        process.exit(2);
    }

    // 支持通过环境变量开启“全表扫描”模式：
    // - SCAN_ALL=true / 1
    // - 或 ALL=true / 1
    // 另外也兼容 BATCH_SIZE=all 这种写法。
    const rawBatchSizeEnv = process.env.BATCH_SIZE || '';
    const scanAll =
        ((process.env.SCAN_ALL || process.env.ALL || '').toLowerCase() === 'true') ||
        ((process.env.SCAN_ALL || process.env.ALL || '') === '1') ||
        rawBatchSizeEnv.toLowerCase() === 'all';

    const batchSize = scanAll ? undefined : parseInt(rawBatchSizeEnv || '20', 10);

    console.log('[batch] ▶️ Starting batch scan (only writing to results table, no listeners, no per-item TG).');
    console.log(`[batch] - DB_URL  : ${metaDbUrl}`);
    console.log(`[batch] - RPC_URL : ${process.env.RPC_URL || process.env.ETH_RPC_URL || 'http://localhost:8547'}`);
    if (scanAll) {
        console.log('[batch] - MODE    : ALL (scan all eligible rows in contracts; ignoring BATCH_SIZE)');
    } else {
        console.log(`[batch] - BATCH_SIZE: ${batchSize}`);
    }

    const pool = new Pool({ connectionString: metaDbUrl });

    // 1) Ensure the result table exists
    {
        const client = await pool.connect();
        try {
            // Create the table if it does not exist (new databases will include all columns directly)
            await client.query(`
                CREATE TABLE IF NOT EXISTS proxy_scan_results (
                    address VARCHAR(42) PRIMARY KEY,
                    upgrade_governance_risk VARCHAR(10) DEFAULT 'NONE',
                    storage_collision_risk VARCHAR(10) DEFAULT 'NONE',
                    initializer_exposure_risk VARCHAR(10) DEFAULT 'NONE',
                    mixing_patterns_risk VARCHAR(10) DEFAULT 'NONE',
                    library_misuse_risk VARCHAR(10) DEFAULT 'NONE',
                    raw_report JSONB
                )
            `);
            // Backward compatibility for old databases: add missing columns (e.g. mixing_patterns_risk / library_misuse_risk)
            await client.query(`
                ALTER TABLE proxy_scan_results
                    ADD COLUMN IF NOT EXISTS upgrade_governance_risk VARCHAR(10) DEFAULT 'NONE',
                    ADD COLUMN IF NOT EXISTS storage_collision_risk VARCHAR(10) DEFAULT 'NONE',
                    ADD COLUMN IF NOT EXISTS initializer_exposure_risk VARCHAR(10) DEFAULT 'NONE',
                    ADD COLUMN IF NOT EXISTS mixing_patterns_risk VARCHAR(10) DEFAULT 'NONE',
                    ADD COLUMN IF NOT EXISTS library_misuse_risk VARCHAR(10) DEFAULT 'NONE',
                    ADD COLUMN IF NOT EXISTS raw_report JSONB;
            `);
            console.log('[batch] ✅ Verified result table proxy_scan_results exists and columns are aligned.');
        } finally {
            client.release();
        }
    }

    // 2) Read records from `contracts` where isProxy=true and implementation is non-empty
    let rows: any[] = [];
    try {
        const baseSql = `
            SELECT
                address,
                implementation
            FROM contracts
            WHERE "isProxy" = true
              AND implementation IS NOT NULL
              AND length(implementation) = 42
            ORDER BY "lastSeenAt" DESC NULLS LAST
        `;

        const sql = scanAll ? baseSql : `${baseSql}
            LIMIT $1`;

        const params = scanAll ? [] : [batchSize];

        const res = await pool.query(sql, params);
        rows = res.rows;
        console.log(`[batch] ✅ Selected ${rows.length} addresses from contracts where isProxy=true and implementation is non-empty.`);
        if (!rows.length) {
            console.log('[batch] ⚠️ No eligible records to scan, exiting.');
            await pool.end();
            return;
        }
    } catch (e: any) {
        console.error('[batch] ❌ Failed to read from contracts:', e.message || String(e));
        await pool.end();
        process.exit(1);
    }

    let scanned = 0;
    let analyzed = 0;
    let highRiskCount = 0;

    for (const row of rows) {
        const proxy = String(row.address).trim();
        const logic = String(row.implementation).trim();
        if (!proxy || !logic) {
            console.log('[batch] ⚠️ Skipping record: proxy or implementation is empty', row);
            continue;
        }
        scanned++;
        try {
            const risks = await analyzePair(proxy, logic);
            if (!risks) continue;
            analyzed++;

            const hasHigh =
                risks.upgrade_governance_risk === 'HIGH' ||
                risks.storage_collision_risk === 'HIGH' ||
                risks.initializer_exposure_risk === 'HIGH' ||
                risks.mixing_patterns_risk === 'HIGH' ||
                risks.library_misuse_risk === 'HIGH';
            if (hasHigh) highRiskCount++;

            // upsert 到 proxy_scan_results
            const upsertSql = `
                INSERT INTO proxy_scan_results (
                    address,
                    upgrade_governance_risk,
                    storage_collision_risk,
                    initializer_exposure_risk,
                    mixing_patterns_risk,
                    library_misuse_risk,
                    raw_report
                ) VALUES ($1,$2,$3,$4,$5,$6,$7)
                ON CONFLICT (address) DO UPDATE SET
                    upgrade_governance_risk   = EXCLUDED.upgrade_governance_risk,
                    storage_collision_risk    = EXCLUDED.storage_collision_risk,
                    initializer_exposure_risk = EXCLUDED.initializer_exposure_risk,
                    mixing_patterns_risk      = EXCLUDED.mixing_patterns_risk,
                    library_misuse_risk       = EXCLUDED.library_misuse_risk,
                    raw_report                = EXCLUDED.raw_report;
            `;
            await pool.query(upsertSql, [
                risks.address,
                risks.upgrade_governance_risk,
                risks.storage_collision_risk,
                risks.initializer_exposure_risk,
                risks.mixing_patterns_risk,
                risks.library_misuse_risk,
                risks.raw_report,
            ]);
            console.log(`[batch] 💾 Written to proxy_scan_results: ${risks.address}`);
        } catch (e: any) {
            console.error(`[batch] ❌ Analysis/write failed for proxy=${proxy} logic=${logic}:`, e.message || String(e));
        }
    }

    await pool.end();

    console.log('[batch] ✅ Batch scan completed:', { scanned, analyzed, highRiskCount });

    // 3) Send only one summary Telegram report (if configured), no per-address alerts
    try {
        if (isTelegramEnabled()) {
            const lines: string[] = [];
            lines.push('📊 Batch Proxy Scan Summary');
            lines.push(`Scanned addresses (isProxy=true with implementation): ${scanned}`);
            lines.push(`Pairs successfully analyzed: ${analyzed}`);
            lines.push(`High-risk addresses (any risk = HIGH): ${highRiskCount}`);
            lines.push('');
            lines.push('Results written to table: proxy_scan_results');
            await sendTelegramAlert(lines.join('\n'));
            console.log('[batch] 📤 Batch scan summary sent to Telegram');
        } else {
            console.log('[batch] ℹ️ Telegram is not configured; skipping summary message.');
        }
    } catch (e: any) {
        console.error('[batch] ⚠️ Failed to send Telegram summary message:', e.message || String(e));
    }
}

main().catch((e: any) => {
    console.error('[batch] Runtime error:', e.message || String(e));
    process.exit(1);
});


