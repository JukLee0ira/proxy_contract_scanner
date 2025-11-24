import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

export type SeverityBucket = 'critical' | 'major' | 'minor';

export interface AddressVulnRow {
    address: string;
    vulns: {
        severity: SeverityBucket;
        rawSeverity: string;
        id?: string;
        title?: string;
        category?: string;
    }[];
}

export interface BatchVulnSummary {
    totals: Record<SeverityBucket, number>;
    perAddress: AddressVulnRow[];
}

export interface RealtimeAnalysisPayload {
    proxy: string;
    logic: string;
    sourceMode: 'sources' | 'bytecode';
    findings: any[];
}

/**
 * 将本次批处理扫描的统计结果追加写入在线表格（如 Google Sheets）。
 *
 * 依赖环境变量（任意命名可按需调整）：
 * - GOOGLE_SHEETS_ID / REPORT_SHEET_ID: 目标表格的 ID
 * - GOOGLE_SERVICE_ACCOUNT_EMAIL: Service Account 邮箱
 * - GOOGLE_SERVICE_ACCOUNT_KEY: Service Account 私钥（推荐使用带有 \\n 的单行环境变量）
 *
 * 如果环境未配置完整，或者未安装 googleapis 包，则会优雅地跳过，不影响原有逻辑。
 */
export async function appendBatchReportToSheet(summary: BatchVulnSummary): Promise<void> {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID || process.env.REPORT_SHEET_ID;

    // 优先从密钥文件读取（推荐），其次才是环境变量
    // 支持：
    // - GOOGLE_SERVICE_ACCOUNT_KEY_FILE：显式指定 JSON 密钥文件路径
    // - GOOGLE_APPLICATION_CREDENTIALS：兼容 Google 官方默认变量
    const keyFilePath =
        process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS;

    let clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    let privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

    if (keyFilePath) {
        try {
            const raw = fs.readFileSync(keyFilePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.client_email) clientEmail = String(parsed.client_email);
            if (parsed.private_key) privateKey = String(parsed.private_key);
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.warn('[report] Failed to read service account key file:', e?.message || String(e));
        }
    }

    if (!spreadsheetId || !clientEmail || !privateKey) {
        // 环境未配置时静默跳过，仅打印提示
        // eslint-disable-next-line no-console
        console.log('[report] Spreadsheet export disabled (missing spreadsheet id or service account credentials).');
        return;
    }

    let google: any;
    try {
        // 使用 require 避免在编译期强依赖 googleapis 类型定义
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('googleapis');
        google = mod.google;
    } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn('[report] googleapis package not installed. Run `npm install googleapis` to enable spreadsheet export.');
        return;
    }

    const normalizedKey = privateKey.replace(/\\n/g, '\n');

    // 使用 options 形式构造 JWT，避免旧的“位置参数”签名导致 key 丢失
    const auth = new google.auth.JWT({
        email: clientEmail,
        key: normalizedKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    // 确保提前获取访问令牌，避免 “missing required authentication credential” 报错
    try {
        await auth.authorize();
    } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn('[report] Failed to authorize Google Sheets client:', e?.message || String(e));
        return;
    }

    const sheets = google.sheets({ version: 'v4', auth });

    // 确保目标工作表存在（如果没有则自动创建）
    async function ensureSheetExists(title: string): Promise<void> {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: 'sheets.properties.title',
        });
        const existing =
            (meta.data.sheets || []).some(
                (s: any) => s.properties && s.properties.title === title,
            );
        if (!existing) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [
                        {
                            addSheet: {
                                properties: {
                                    title,
                                },
                            },
                        },
                    ],
                },
            });
        }
    }

    // 确保首行表头存在（如果为空则写入指定表头）
    async function ensureHeaderExists(title: string, headers: string[]): Promise<void> {
        try {
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${title}!1:1`,
            });
            const rows = res.data.values;
            const hasHeader =
                Array.isArray(rows) &&
                rows.length > 0 &&
                Array.isArray(rows[0]) &&
                rows[0].some((cell: any) => String(cell ?? '').trim().length > 0);
            if (hasHeader) return;
        } catch {
            // 如果读取失败，则尝试直接写入表头
        }

        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${title}!A1`,
            valueInputOption: 'RAW',
            requestBody: {
                values: [headers],
            },
        });
    }

    const timestamp = new Date().toISOString();

    // 先确保 Summary / Vulnerabilities 两个 sheet 存在
    await ensureSheetExists('Summary');
    await ensureSheetExists('Vulnerabilities');

    // 再确保各自的表头存在
    await ensureHeaderExists('Summary', [
        'timestamp',
        'critical_total',
        'major_total',
        'minor_total',
    ]);
    await ensureHeaderExists('Vulnerabilities', [
        'timestamp',
        'address',
        'severity_bucket',
        'raw_severity',
        'finding_id',
        'finding_title',
        'categories',
    ]);

    // Sheet1: Summary —— 一行写入本次批次的全局统计（数据从第 2 行开始）
    const summaryValues: (string | number)[][] = [
        [timestamp, summary.totals.critical, summary.totals.major, summary.totals.minor],
    ];

    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: 'Summary!A2',
        valueInputOption: 'RAW',
        requestBody: {
            values: summaryValues,
        },
    });

    // Sheet2: Vulnerabilities —— 展开为每行一个漏洞明细
    const detailRows: (string | number)[][] = [];
    for (const row of summary.perAddress) {
        for (const v of row.vulns) {
            detailRows.push([
                timestamp,
                row.address,
                v.severity,
                v.rawSeverity,
                v.id ?? '',
                v.title ?? '',
                v.category ?? '',
            ]);
        }
    }

    if (detailRows.length > 0) {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'Vulnerabilities!A2',
            valueInputOption: 'RAW',
            requestBody: {
                values: detailRows,
            },
        });
    }

    // eslint-disable-next-line no-console
    console.log('[report] Spreadsheet export completed.', {
        summaryRows: summaryValues.length,
        detailRows: detailRows.length,
    });
}

/**
 * 将实时监听/分析模式下的单次 pair 分析结果写入在线表格（独立于批处理使用的 sheet）。
 *
 * 使用的 sheet 名称：
 * - RT_Summary: 每次分析一行汇总（proxy, logic, source_mode + 各严重度计数）
 * - RT_Vulnerabilities: 每条 finding 一行明细
 */
export async function appendRealtimeAnalysisToSheet(payload: RealtimeAnalysisPayload): Promise<void> {
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID || process.env.REPORT_SHEET_ID;
    const keyFilePath =
        process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS;

    let clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    let privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

    if (keyFilePath) {
        try {
            const raw = fs.readFileSync(keyFilePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.client_email) clientEmail = String(parsed.client_email);
            if (parsed.private_key) privateKey = String(parsed.private_key);
        } catch (e: any) {
            // eslint-disable-next-line no-console
            console.warn('[report] (rt) Failed to read service account key file:', e?.message || String(e));
        }
    }

    if (!spreadsheetId || !clientEmail || !privateKey) {
        // eslint-disable-next-line no-console
        console.log('[report] (rt) Spreadsheet export disabled (missing spreadsheet id or service account credentials).');
        return;
    }

    let google: any;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('googleapis');
        google = mod.google;
    } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn('[report] (rt) googleapis package not installed. Run `npm install googleapis` to enable spreadsheet export.');
        return;
    }

    const normalizedKey = privateKey.replace(/\\n/g, '\n');
    const auth = new google.auth.JWT({
        email: clientEmail,
        key: normalizedKey,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    try {
        await auth.authorize();
    } catch (e: any) {
        // eslint-disable-next-line no-console
        console.warn('[report] (rt) Failed to authorize Google Sheets client:', e?.message || String(e));
        return;
    }

    const sheets = google.sheets({ version: 'v4', auth });

    async function ensureSheetExists(title: string): Promise<void> {
        const meta = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: 'sheets.properties.title',
        });
        const existing =
            (meta.data.sheets || []).some(
                (s: any) => s.properties && s.properties.title === title,
            );
        if (!existing) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [
                        {
                            addSheet: {
                                properties: {
                                    title,
                                },
                            },
                        },
                    ],
                },
            });
        }
    }

    async function ensureHeaderExists(title: string, headers: string[]): Promise<void> {
        try {
            const res = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${title}!1:1`,
            });
            const rows = res.data.values;
            const hasHeader =
                Array.isArray(rows) &&
                rows.length > 0 &&
                Array.isArray(rows[0]) &&
                rows[0].some((cell: any) => String(cell ?? '').trim().length > 0);
            if (hasHeader) return;
        } catch {
            // ignore and try to write header
        }

        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${title}!A1`,
            valueInputOption: 'RAW',
            requestBody: {
                values: [headers],
            },
        });
    }

    const findings = Array.isArray(payload.findings) ? payload.findings : [];
    if (!findings.length) {
        // 没有漏洞时不写 RT_Vulnerabilities，但仍可选择写一行 summary；这里简单跳过
        // eslint-disable-next-line no-console
        console.log('[report] (rt) No findings for this analysis, skipping spreadsheet export.');
        return;
    }

    // 统计本次分析中的严重度分布
    const totals: Record<SeverityBucket, number> = {
        critical: 0,
        major: 0,
        minor: 0,
    };

    function mapBucket(raw: any): SeverityBucket | null {
        const v = String(raw || '').toLowerCase();
        if (v === 'critical' || v === 'high') return 'critical';
        if (v === 'medium') return 'major';
        if (v === 'low' || v === 'info' || v === 'information') return 'minor';
        return null;
    }

    function buildCategories(f: any): string {
        const id = String(f?.id || '').toLowerCase();
        const title = String(f?.title || '').toLowerCase();
        const text = `${id} ${title}`;
        const groups: string[] = [];
        if (text.includes('admin-privilege') || text.includes('upgrade-governance') || text.includes('upgrade access control') || text.includes('admin access')) {
            groups.push('upgrade_governance');
        }
        if (text.includes('storage-collision') || text.includes('storage collision')) {
            groups.push('storage_collision');
        }
        if (text.includes('uninitialized') || text.includes('initializer') || text.includes('initialize')) {
            groups.push('initializer_exposure');
        }
        if (text.includes('mixing-patterns') || text.includes('mixing_patterns')) {
            groups.push('mixing_patterns');
        }
        if (text.includes('library-misuse') || text.includes('library_misuse')) {
            groups.push('library_misuse');
        }
        return groups.join(',');
    }

    const timestamp = new Date().toISOString();

    // sheet 准备：RT_Summary / RT_Vulnerabilities
    const summarySheet = 'RT_Summary';
    const vulnSheet = 'RT_Vulnerabilities';
    await ensureSheetExists(summarySheet);
    await ensureSheetExists(vulnSheet);
    await ensureHeaderExists(summarySheet, [
        'timestamp',
        'proxy',
        'logic',
        'source_mode',
        'critical_total',
        'major_total',
        'minor_total',
    ]);
    await ensureHeaderExists(vulnSheet, [
        'timestamp',
        'proxy',
        'logic',
        'severity_bucket',
        'raw_severity',
        'finding_id',
        'finding_title',
        'categories',
    ]);

    const vulnRows: (string | number)[][] = [];
    for (const f of findings) {
        const bucket = mapBucket(f?.severity);
        if (!bucket) continue;
        totals[bucket]++;
        vulnRows.push([
            timestamp,
            payload.proxy,
            payload.logic,
            bucket,
            String(f?.severity ?? ''),
            f?.id ?? '',
            f?.title ?? '',
            buildCategories(f),
        ]);
    }

    const summaryRow: (string | number)[] = [
        timestamp,
        payload.proxy,
        payload.logic,
        payload.sourceMode,
        totals.critical,
        totals.major,
        totals.minor,
    ];

    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${summarySheet}!A2`,
        valueInputOption: 'RAW',
        requestBody: {
            values: [summaryRow],
        },
    });

    if (vulnRows.length > 0) {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${vulnSheet}!A2`,
            valueInputOption: 'RAW',
            requestBody: {
                values: vulnRows,
            },
        });
    }

    // eslint-disable-next-line no-console
    console.log('[report] (rt) Realtime analysis exported to spreadsheet.', {
        summaryRow: true,
        vulnRows: vulnRows.length,
    });
}


