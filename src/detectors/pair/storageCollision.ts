import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';

export const StorageCollisionPairDetector: PairDetector = {
    name: 'storage-collision',
    run(ctx: PairDetectorContext): PairDetectorFinding[] {
        const proxyContracts = Array.isArray(ctx.proxy.slither?.contracts) ? ctx.proxy.slither.contracts.length : 0;
        const logicContracts = Array.isArray(ctx.logic.slither?.contracts) ? ctx.logic.slither.contracts.length : 0;
        const proxySources = ctx.proxy.sources ? Object.keys(ctx.proxy.sources).length : 0;
        const logicSources = ctx.logic.sources ? Object.keys(ctx.logic.sources).length : 0;

        const haveProxySlither = !!ctx.proxy.slither && (proxyContracts > 0 || Object.keys(ctx.proxy.slither).length > 0);
        const haveLogicSlither = !!ctx.logic.slither && (logicContracts > 0 || Object.keys(ctx.logic.slither).length > 0);

        const findings: PairDetectorFinding[] = [];

        findings.push({
            id: 'storage-collision-pipeline',
            title: 'Pipeline check for storage-collision (sources/slither presence)',
            severity: haveProxySlither && haveLogicSlither ? 'info' : 'low',
            metadata: {
                proxyAddress: ctx.proxy.address,
                logicAddress: ctx.logic.address,
                proxySummary: { slither: haveProxySlither, contracts: proxyContracts, sources: proxySources },
                logicSummary: { slither: haveLogicSlither, contracts: logicContracts, sources: logicSources },
            } as any
        });

        return findings;
    }
};


