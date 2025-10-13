import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { getVerifiedSource } from '../clients/etherscan';

export interface AnalyzeResult {
    tool: string;
    status: 'completed' | 'failed';
    rawOutput: string;
    parsed?: any;
}

function writeSourcesToTmp(sources: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slither-src-'));
    for (const [filename, content] of Object.entries(sources)) {
        const filePath = path.join(dir, filename);
        const dirName = path.dirname(filePath);
        fs.mkdirSync(dirName, { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
    }
    return dir;
}

function dockerExists(): Promise<boolean> {
    return new Promise((resolve) => {
        const p = spawn('docker', ['--version']);
        p.on('error', () => resolve(false));
        p.on('exit', (code) => resolve(code === 0));
    });
}

async function runSlitherDocker(sourceDir: string): Promise<string> {
    const hasDocker = await dockerExists();
    if (!hasDocker) throw new Error('docker_not_found');
    const outFile = path.join(sourceDir, 'slither.json');
    const image = process.env.SLITHER_IMAGE || 'trailofbits/eth-security-toolbox:latest';
    const args = [
        'run', '--rm',
        '-v', `${sourceDir}:/src`,
        '-v', `${sourceDir}:/out`,
        image, 'slither', '/src', '--json', '/out/slither.json'
    ];
    await new Promise<void>((resolve, reject) => {
        const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('exit', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`slither_exit_${code}: ${stderr}`));
            }
        });
        proc.on('error', (err) => reject(err));
    });
    const raw = fs.readFileSync(outFile, 'utf8');
    return raw;
}

export async function analyzeContract(address: string): Promise<AnalyzeResult> {
    const addr = address.toLowerCase();
    try {
        const verified = await getVerifiedSource(addr);
        const dir = writeSourcesToTmp(verified.sources);
        const raw = await runSlitherDocker(dir);

        // Slither --json writes to file; some images also echo report lines. We keep raw stdout/stderr for now.
        let parsed: any = undefined;
        try {
            parsed = JSON.parse(raw);
        } catch {}
        const result: AnalyzeResult = {
            tool: 'slither',
            status: 'completed',
            rawOutput: raw,
            parsed,
        };
        console.log(`[analyzeContract] ${addr} -> completed`);

        return result;
    } catch (e: any) {
        const message = e?.message || String(e);
        const result: AnalyzeResult = {
            tool: 'slither',
            status: 'failed',
            rawOutput: message,
        };
        console.warn(`[analyzeContract] ${addr} -> failed: ${message}`);
        return result;
    }
}


