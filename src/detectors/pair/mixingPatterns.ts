import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';

export const MixingPatternsPairDetector: PairDetector = {
    name: 'mixing_patterns',
    async run(ctx: PairDetectorContext): Promise<PairDetectorFinding[]> {
        const findings: PairDetectorFinding[] = [];

        // Placeholder implementation – real logic to be added later.
        // For now we just emit an informational finding so we know the detector is wired up correctly.
        findings.push({
            id: 'mixing-patterns-placeholder',
            title: 'mixing_patterns detector is wired but not yet implemented',
            severity: 'info',
            metadata: {
                proxyAddress: ctx.proxy.address,
                logicAddress: ctx.logic.address,
                notes: 'This is a placeholder result from mixing_patterns pair detector. Implementation TBD.',
            },
        });

        return findings;
    },
};


