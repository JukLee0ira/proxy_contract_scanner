import axios from 'axios';
import * as dotenv from "dotenv";

dotenv.config();

export interface VerifiedSourceResponse {
    contractName: string;
    compilerVersion: string;
    sources: Record<string, string>; // filename -> content
}

function normalizeSourceCode(raw: string): Record<string, string> {
    if (!raw) return { 'Contract.sol': '' };
    let text = raw.trim();
    if ((text.startsWith('{{') && text.endsWith('}}')) || (text.startsWith('{') && text.endsWith('}'))) {
        try {
            // Some Etherscan variants wrap JSON with extra braces
            const cleaned = text.startsWith('{{') ? text.slice(1, -1) : text;
            const parsed = JSON.parse(cleaned);
            if (parsed && parsed.sources && typeof parsed.sources === 'object') {
                const out: Record<string, string> = {};
                for (const [file, obj] of Object.entries(parsed.sources)) {
                    const content = (obj as any)?.content ?? '';
                    out[file] = content;
                }
                return out;
            }
        } catch {
            // fallthrough to flattened mode
        }
    }
    return { 'Contract.sol': raw };
}

export async function getVerifiedSource(address: string): Promise<VerifiedSourceResponse> {
    const baseUrl = process.env.ETHERSCAN_BASE_URL || 'https://api.etherscan.io/v2/api';
    const apiKey = process.env.ETHERSCAN_API_KEY || '';
    const isV2 = baseUrl.includes('/v2/');
    const chainId = process.env.ETHERSCAN_CHAIN_ID;

    if (isV2 && !chainId) {
        throw new Error('etherscan_v2_requires_chainid: set ETHERSCAN_CHAIN_ID (e.g. 1 for mainnet)');
    }

    const params = new URLSearchParams();
    if (isV2 && chainId) params.set('chainid', chainId);
    params.set('module', 'contract');
    params.set('action', 'getsourcecode');
    params.set('address', address);
    if (apiKey) params.set('apikey', apiKey);

    const url = `${baseUrl}?${params.toString()}`;
    const resp = await axios.get(url, { timeout: 30000 });
    const data = resp.data;
    if (!data || data.status !== '1' || !Array.isArray(data.result) || data.result.length === 0) {
        const message = data?.result || data?.message || 'etherscan_error';
        throw new Error(`Failed to fetch source from Etherscan: ${message}`);
    }
    const item = data.result[0];
    const sources = normalizeSourceCode(item.SourceCode || '');
    return {
        contractName: item.ContractName || 'Contract',
        compilerVersion: item.CompilerVersion || '',
        sources,
    };
}


