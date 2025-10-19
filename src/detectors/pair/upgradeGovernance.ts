import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';
import { ethers } from 'ethers';

async function simulateUpgradeCall(provider: ethers.Provider, proxy: string, newImpl: string, from: string): Promise<{ ok: boolean; reason?: string }>{
    const iface = new ethers.Interface(['function upgradeTo(address newImplementation)']);
    const data = iface.encodeFunctionData('upgradeTo', [newImpl]);
    try {
        const rv = await provider.call({ to: proxy, from, data });
        // If call didn't revert, rv is hex data (often 0x). Treat as success (unprotected path)
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

        const sim = await simulateUpgradeCall(provider, proxy, logic, attacker);
        if (sim.ok) {
            findings.push({
                id: 'upgrade-unprotected',
                title: 'upgradeTo is callable by non-admin (potentially unprotected)',
                severity: 'high',
                metadata: { proxy, logic, from: attacker }
            });
        } else {
            findings.push({
                id: 'upgrade-protected',
                title: 'upgradeTo reverted for non-admin (likely protected)',
                severity: 'info',
                metadata: { proxy, logic, from: attacker, reason: sim.reason }
            });
        }

        return findings;
    }
};

 




