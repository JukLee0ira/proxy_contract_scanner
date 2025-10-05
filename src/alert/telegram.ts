import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

type UpgradeAlertPayload = {
    proxyAddress: string;
    newImplementation: string;
    blockNumber?: number;
    txHash?: string;
    detection: 'event' | 'storage' | 'discovery';
};

function getBotToken(): string | undefined {
    return process.env.TG_BOT_TOKEN;
}

function getChatIds(): string[] {
    const raw = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_IDS || process.env.TG_CHAT_ID || '';
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

export function isTelegramEnabled(): boolean {
    return Boolean(getBotToken() && getChatIds().length > 0);
}

export function buildUpgradeAlertMessage(payload: UpgradeAlertPayload): string {
    const lines: string[] = [];
    lines.push('⚠️ Proxy Upgrade Detected');
    lines.push(`Proxy: ${payload.proxyAddress}`);
    lines.push(`New Impl: ${payload.newImplementation}`);
    if (payload.blockNumber && payload.blockNumber > 0) {
        lines.push(`Block: ${payload.blockNumber}`);
    }
    if (payload.txHash && payload.txHash.length > 0) {
        lines.push(`Tx: ${payload.txHash}`);
    }
    lines.push(`Detection: ${payload.detection}`);
    return lines.join('\n');
}

export async function sendTelegramAlert(message: string): Promise<void> {
    const token = getBotToken();
    const chatIds = getChatIds();
    if (!token || chatIds.length === 0) {
        return;
    }

    const baseUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    // Prefer TELEGRAM_PROXY; fallback to HTTPS_PROXY/HTTP_PROXY (case-insensitive)
    const proxyRaw = process.env.TELEGRAM_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    let axiosConfig: any = undefined;
    if (proxyRaw) {
        try {
            const u = new URL(proxyRaw);
            const auth = u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password || '') } : undefined;
            axiosConfig = {
                proxy: {
                    protocol: u.protocol.replace(':', '') || 'http',
                    host: u.hostname,
                    port: u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80),
                    auth,
                }
            } as any;
        } catch {
            // ignore invalid proxy URL
        }
    }

    await Promise.all(
        chatIds.map((chatId) =>
            axios
                .post(
                    baseUrl,
                    {
                        chat_id: chatId,
                        text: message,
                        disable_web_page_preview: true,
                    },
                    axiosConfig
                )
                .catch((err) => {
                    // Do not throw to avoid breaking the scanner; just log
                    const reason = err instanceof Error ? err.message : String(err);
                    // eslint-disable-next-line no-console
                    console.warn(`Telegram alert failed for chat ${chatId}: ${reason}`);
                })
        )
    );
}


