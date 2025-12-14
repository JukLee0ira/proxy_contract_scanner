import { Pool } from 'pg';
import { ethers } from 'ethers';
import { analyzeContract } from '../src/services/analyzer';
import { runPairDetectors } from '../src/detectors/pair';
import { UpgradeGovernancePairDetector } from '../src/detectors/pair/upgradeGovernance';
import { StorageCollisionPairDetector } from '../src/detectors/pair/storageCollision';
import { InitializerMistakesPairDetector } from '../src/detectors/pair/initializerMistakes';
import { MixingPatternsPairDetector } from '../src/detectors/pair/mixingPatterns';
import { LibraryMisusePairDetector } from '../src/detectors/pair/libraryMisuse';
import { getVerifiedSource } from '../src/clients/etherscan';
import { isTelegramEnabled, sendTelegramAlert } from '../src/alert/telegram';

type Severity = 'NONE' | 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH';
type VulnBucket = 'critical' | 'major' | 'minor';

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

// 简单的 sleep，供重试时退避使用
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 粗粒度判断是否属于“网络/节点相关”的错误，方便做重试与统计
function isNetworkLikeError(err: any): boolean {
    const msg = (err?.message || String(err || '')).toLowerCase();
    if (!msg) return false;
    return [
        'etimedout',
        'timeout',
        'econnreset',
        'econnrefused',
        'network error',
        'socket hang up',
        '503 service unavailable',
        '502 bad gateway',
        '504 gateway timeout',
        'too many requests',
        'rate limit',
        '429',
        'dns lookup failed',
    ].some((k) => msg.includes(k));
}

/**
 * 运行期中断标记：
 * - 第一次 Ctrl+C：设置为 true，当前合约处理完毕后安全退出
 * - 第二次 Ctrl+C：立刻强制退出
 */
let interruptRequested = false;
process.on('SIGINT', () => {
    if (interruptRequested) {
        console.log('[batch] ⚠️ Second SIGINT received, exiting immediately.');
        process.exit(130);
    }
    interruptRequested = true;
    console.log('[batch] ⏹️ SIGINT (Ctrl+C) received, will stop after finishing current address.');
    console.log('[batch]     Already processed addresses are stored in proxy_scan_results.');
    console.log('[batch]     Re-run the same command to automatically continue from remaining contracts.');
});

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

/**
 * 将原始 severity 映射到报表用的 3 档严重等级
 * - critical: CRITICAL/HIGH
 * - major:   MEDIUM
 * - minor:   LOW/INFO/其他
 */
function mapFindingSeverityBucket(raw: any): VulnBucket | null {
    const v = String(raw || '').toLowerCase();
    if (v === 'critical' || v === 'high') return 'critical';
    if (v === 'medium') return 'major';
    if (v === 'low' || v === 'info' || v === 'information') return 'minor';
    return null;
}

function buildFindingCategoriesLabel(f: any): string {
    const cat = classifyFinding(f);
    const groups: string[] = [];
    if (cat.upgrade) groups.push('upgrade_governance');
    if (cat.storage) groups.push('storage_collision');
    if (cat.initializer) groups.push('initializer_exposure');
    if (cat.mixing) groups.push('mixing_patterns');
    if (cat.library) groups.push('library_misuse');
    return groups.join(',');
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
    const rpcUrl : string =process.env.RPC_URL || 'https://rpc.ankr.com/xdc/ ';
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
    console.log(`[batch] - RPC_URL : ${process.env.RPC_URL}`);
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

    // 2) 逐批从 `contracts` 读取记录：
    //    - 只选择 isProxy=true、implementation 非空且长度正确的行
    //    - 跳过已经在 proxy_scan_results 中存在的地址，实现断点续扫
    //    - 若设置 BATCH_SIZE，则每次只处理该数量；否则在 scanAll 模式下一次性取完
    let scanned = 0;
    let analyzed = 0;
    let highRiskCount = 0;
    let networkFailureCount = 0;
    let otherFailureCount = 0;
    let consecutiveNetworkFailures = 0;

    // 本次批处理中，按 3 档严重等级统计的漏洞总数
    const vulnTotals: Record<VulnBucket, number> = {
        critical: 0,
        major: 0,
        minor: 0,
    };
    // 供后续导出报表（如 Google Sheets）使用的按地址漏洞明细
    const perAddressVulns: Record<string, {
        address: string;
        vulns: {
            severity: VulnBucket;
            rawSeverity: string;
            id?: string;
            title?: string;
            category?: string;
        }[];
    }> = {};

    // 循环按批次读取 + 扫描，直到：
    // - 没有更多未扫描的记录；或
    // - 收到中断信号（interruptRequested = true）
    while (true) {
        if (interruptRequested) {
            console.log('[batch] ⏹️ Interrupt flag set before fetching next batch, stopping main loop.');
            break;
        }

        let rows: any[] = [];
        try {
            // 候选来源改为 proxy_contracts：
            // - 只对已经通过 /monitor 判定为代理、且有 logic_contract 的记录做配对安全分析
            // - 避免再次依赖 contracts.isProxy 这一旧字段
            const baseSql = `
                SELECT
                    p.proxy_address AS address,
                    p.logic_contract AS implementation
                FROM proxy_contracts p
                LEFT JOIN proxy_scan_results r
                    ON LOWER(r.address) = LOWER(p.proxy_address)
                WHERE p.logic_contract IS NOT NULL
                  AND length(p.logic_contract) = 42
                  AND r.address IS NULL
                ORDER BY p.detected_at DESC NULLS LAST
            `;

            const sql = scanAll || !batchSize
                ? baseSql
                : `${baseSql}
                LIMIT $1`;

            const params = scanAll || !batchSize ? [] : [batchSize];

            const res = await pool.query(sql, params);
            rows = res.rows;
            console.log(`[batch] ✅ Fetched ${rows.length} new addresses to scan (skipping already in proxy_scan_results).`);
            if (!rows.length) {
                console.log('[batch] 🎉 No more eligible records to scan, exiting main loop.');
                break;
            }
        } catch (e: any) {
            const code = (e as any)?.code || (e as any)?.original?.code;
            const msg = (e as any)?.message || String(e);

            // 42P01: undefined_table —— proxy_contracts 表不存在，给出更明确的指引
            if (code === '42P01') {
                console.error('[batch] ❌ Required table "proxy_contracts" does not exist in this database.');
                console.error('[batch]     - Ensure the scanner API (src/index.ts) has been started at least once with this database config,');
                console.error('[batch]     - so that createTablesIfNotExist() in proxyScannerDemo.ts can create proxy_contracts.');
                console.error('[batch]     - Also make sure DB_HOST/DB_NAME for src/index.ts match XDC_META_DB_URL used for scanBatch/monitorFromContracts.');
            } else {
                console.error('[batch] ❌ Failed to read from proxy_contracts:', msg);
            }
            await pool.end();
            process.exit(1);
        }

        for (const row of rows) {
            if (interruptRequested) {
                console.log('[batch] ⏹️ Interrupt flag set, stop before next address.');
                break;
            }

            const proxy = String(row.address).trim();
            const logic = String(row.implementation).trim();
            if (!proxy || !logic) {
                console.log('[batch] ⚠️ Skipping record: proxy or implementation is empty', row);
                continue;
            }
            scanned++;
            // 每个地址内支持有限次重试，主要针对网络/节点类错误
            const maxRetriesPerAddress = parseInt(process.env.MAX_RETRIES_PER_ADDRESS || '3', 10);
            const baseDelayMs = parseInt(process.env.RETRY_BASE_DELAY_MS || '1000', 10);
            const maxConsecutiveNetworkErrors = parseInt(process.env.MAX_CONSECUTIVE_NETWORK_ERRORS || '20', 10);

            let risks: RiskRow | null = null;
            let attempt = 0;

            while (attempt <= maxRetriesPerAddress && !interruptRequested) {
                try {
                    if (attempt > 0) {
                        console.log(`[batch] 🔁 Retry analyzePair (attempt ${attempt}/${maxRetriesPerAddress}) for proxy=${proxy.toLowerCase()}`);
                    }
                    risks = await analyzePair(proxy, logic);
                    consecutiveNetworkFailures = 0; // 成功一次就清空连续网络错误计数
                    break;
                } catch (e: any) {
                    const isNet = isNetworkLikeError(e);
                    const msg = e?.message || String(e);

                    if (isNet) {
                        networkFailureCount++;
                        consecutiveNetworkFailures++;
                        console.error(`[batch] 🌐 Network / RPC error for proxy=${proxy} logic=${logic} (attempt ${attempt}): ${msg}`);
                        if (consecutiveNetworkFailures >= maxConsecutiveNetworkErrors) {
                            console.error('[batch] 🚨 Too many consecutive network/RPC failures, will stop fetching new batches.');
                            interruptRequested = true;
                            break;
                        }

                        if (attempt < maxRetriesPerAddress) {
                            const delay = baseDelayMs * (attempt + 1);
                            console.log(`[batch] ⏳ Will retry after ${delay} ms...`);
                            await sleep(delay);
                            attempt++;
                            continue;
                        } else {
                            console.error(`[batch] ❌ Giving up on proxy=${proxy} logic=${logic} after ${maxRetriesPerAddress} retries (network/RPC).`);
                            break;
                        }
                    } else {
                        otherFailureCount++;
                        console.error(`[batch] ❌ Non-network analysis error for proxy=${proxy} logic=${logic}:`, msg);
                        // 非网络错误一般是数据/解析问题，不做重试，直接放弃该地址
                        break;
                    }
                }
            }

            if (!risks || interruptRequested) {
                // 没拿到有效结果（多次重试失败），或已经收到中断信号：直接进入下一条 / 退出
                continue;
            }

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

            // 额外：基于 raw_report 中的 findings 统计漏洞数量，并为后续报表导出收集明细
            const findings: any[] =
                (risks.raw_report && (risks.raw_report as any).findings && Array.isArray((risks.raw_report as any).findings))
                    ? (risks.raw_report as any).findings
                    : [];
            if (findings.length) {
                const addr = risks.address;
                if (!perAddressVulns[addr]) {
                    perAddressVulns[addr] = { address: addr, vulns: [] };
                }
                for (const f of findings) {
                    const bucket = mapFindingSeverityBucket(f?.severity);
                    if (!bucket) continue;
                    vulnTotals[bucket]++;
                    perAddressVulns[addr].vulns.push({
                        severity: bucket,
                        rawSeverity: String(f?.severity ?? ''),
                        id: f?.id,
                        title: f?.title,
                        category: buildFindingCategoriesLabel(f) || undefined,
                    });
                }
            }
        }

        // 如果已经收到中断信号，当前批次处理完毕后跳出主循环
        if (interruptRequested) {
            console.log('[batch] ⏹️ Interrupt flag set after finishing current batch, leaving main loop.');
            break;
        }
    }

    await pool.end();

    console.log('[batch] ✅ Batch scan completed:', {
        scanned,
        analyzed,
        highRiskCount,
        networkFailureCount,
        otherFailureCount,
    });

    // 3) Send only one summary Telegram report (if configured), no per-address alerts
    try {
        if (isTelegramEnabled()) {
            const lines: string[] = [];
            lines.push('📊 Batch Proxy Scan Summary');
            // scanned: 本轮从数据库选出的「待分析候选记录」总数
            lines.push(`Candidate records selected for analysis in this batch: ${scanned}`);
            // analyzed: 实际成功完成 proxy-logic 配对安全分析的数量
            lines.push(`Pairs successfully analyzed (proxy + logic): ${analyzed}`);
            lines.push(`High-risk proxies (any risk = HIGH): ${highRiskCount}`);
            lines.push('');
            lines.push('Results written to table: proxy_scan_results');
            lines.push('');
            lines.push('📌 Vulnerabilities in this batch');
            lines.push(`critical: ${vulnTotals.critical}`);
            lines.push(`major: ${vulnTotals.major}`);
            lines.push(`minor: ${vulnTotals.minor}`);

            // 如果配置了在线报表（Google Sheets），在 TG 报告中附上链接
            const sheetId = process.env.GOOGLE_SHEETS_ID || process.env.REPORT_SHEET_ID;
            const sheetUrlFromEnv = process.env.GOOGLE_SHEETS_URL;
            const sheetUrl = sheetUrlFromEnv || (sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : undefined);
            if (sheetUrl) {
                lines.push('');
                lines.push(`Reported to Google Sheet: ${sheetUrl}`);
            }

            await sendTelegramAlert(lines.join('\n'));
            console.log('[batch] 📤 Batch scan summary sent to Telegram');
        } else {
            console.log('[batch] ℹ️ Telegram is not configured; skipping summary message.');
        }
    } catch (e: any) {
        console.error('[batch] ⚠️ Failed to send Telegram summary message:', e.message || String(e));
    }

    // 4) Optional: export this batch report to an online spreadsheet (e.g. Google Sheets)
    try {
        const totalVulns =
            vulnTotals.critical +
            vulnTotals.major +
            vulnTotals.minor;
        const addressesWithVulns = Object.values(perAddressVulns);

        if (totalVulns === 0 || addressesWithVulns.length === 0) {
            console.log('[batch] ℹ️ No vulnerabilities detected in this batch; skipping spreadsheet export.');
        } else {
            // 动态导入，避免在未安装 googleapis 或未配置环境变量时影响现有逻辑
            const mod = await import('../src/report/googleSheet');
            // 使用 any 避免在 scripts 目录引入 src 内的类型依赖
            await (mod as any).appendBatchReportToSheet({
                totals: vulnTotals,
                perAddress: addressesWithVulns,
            });
        }
    } catch (e: any) {
        console.warn('[batch] ⚠️ Failed to export batch report to spreadsheet:', e?.message || String(e));
    }
}

main().catch((e: any) => {
    console.error('[batch] Runtime error:', e.message || String(e));
    process.exit(1);
});


