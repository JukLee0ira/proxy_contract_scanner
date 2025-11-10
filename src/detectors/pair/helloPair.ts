import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';

export const HelloPairDetector: PairDetector = {
    name: 'hello-pair',
    run(ctx: PairDetectorContext): PairDetectorFinding[] {
        return [{
            id: 'hello-pair-1',
            title: 'System: pair detector operational',
            severity: 'info',
            metadata: {
                proxy: ctx.proxy.address,
                logic: ctx.logic.address,
                proxyContracts: Array.isArray(ctx.proxy.slither?.contracts) ? ctx.proxy.slither.contracts.length : undefined,
                logicContracts: Array.isArray(ctx.logic.slither?.contracts) ? ctx.logic.slither.contracts.length : undefined,
            },
        }];
    }
};


