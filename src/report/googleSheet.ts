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

    const timestamp = new Date().toISOString();

    // 先确保 Summary / Vulnerabilities 两个 sheet 存在
    await ensureSheetExists('Summary');
    await ensureSheetExists('Vulnerabilities');

    // Sheet1: Summary —— 一行写入本次批次的全局统计
    const summaryValues: (string | number)[][] = [
        // 不重复写表头，假定用户预先在 Summary!A1 手动创建表头
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


