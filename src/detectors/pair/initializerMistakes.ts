import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';

export const InitializerMistakesPairDetector: PairDetector = {
    name: 'initializer_mistakes',
    run(ctx: PairDetectorContext): PairDetectorFinding[] {
        return [{
            id: 'initializer-mistakes-placeholder',
            title: 'Initializer mistakes detector placeholder',
            severity: 'info',
            metadata: {
                proxy: ctx.proxy.address,
                logic: ctx.logic.address,
                note: 'Implementation pending. This is a stub output.'
            },
        }];
    }
};


