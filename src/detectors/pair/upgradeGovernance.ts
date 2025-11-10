import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';
import { ethers } from 'ethers';

async function tryCall(
    provider: ethers.Provider,
    to: string,
    from: string,
    data: string
): Promise<{ ok: boolean; reason?: string }>{
    try {
        await provider.call({ to, from, data });
        return { ok: true };
    } catch (e: any) {
        const reason = e?.shortMessage || e?.message || (typeof e?.error?.message === 'string' ? e.error.message : undefined);
        return { ok: false, reason };
    }
}

export const UpgradeGovernancePairDetector: PairDetector = {
    name: 'upgrade-governance',
    async run(ctx: PairDetectorContext): Promise<PairDetectorFinding[]> {
        const findings: PairDetectorFinding[] = [];
        const rpcUrl = process.env.RPC_URL || process.env.ETH_RPC_URL || 'http://localhost:8547';
        const provider = new ethers.JsonRpcProvider(rpcUrl);

        const proxy = ctx.proxy.address;
        const logic = ctx.logic.address;
        const attacker = '0x000000000000000000000000000000000000dEaD';

        // Try a set of common upgrade entrypoints on the proxy itself
        const candidates: { name: string; fragment: string; args: any[] }[] = [
            { name: 'upgradeTo(address)', fragment: 'function upgradeTo(address newImplementation)', args: [logic] },
            { name: 'upgrade(address)', fragment: 'function upgrade(address newImpl)', args: [logic] },
            { name: 'upgradeToAndCall(address,bytes)', fragment: 'function upgradeToAndCall(address newImplementation, bytes data)', args: [logic, '0x'] },
        ];

        let unprotected: { method: string } | undefined;
        let lastReason: string | undefined;
        for (const c of candidates) {
            const iface = new ethers.Interface([c.fragment]);
            const data = iface.encodeFunctionData(c.fragment.split(' ')[1].split('(')[0], c.args);
            const res = await tryCall(provider, proxy, attacker, data);
            if (res.ok) {
                unprotected = { method: c.name };
                break;
            }
            lastReason = res.reason || lastReason;
        }

        if (unprotected) {
            findings.push({
                id: 'upgrade-unprotected',
                title: 'Upgrade access control: unprotected (callable by non-admin)',
                severity: 'high',
                metadata: { proxy, logic, from: attacker, methodTried: unprotected.method }
            });
        } else {
            findings.push({
                id: 'upgrade-protected',
                title: 'Upgrade access control: protected (non-admin blocked)',
                severity: 'info',
                metadata: { proxy, logic, from: attacker, reason: lastReason }
            });
        }

        return findings;
    }
};

 





