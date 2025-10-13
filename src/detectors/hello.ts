import { Detector, DetectorContext, DetectorFinding } from './index';

export const HelloDetector: Detector = {
    name: 'hello',
    run(ctx: DetectorContext): DetectorFinding[] {
        const contractCount = Array.isArray(ctx.slither?.contracts) ? ctx.slither.contracts.length : undefined;
        return [{
            id: 'hello-1',
            title: 'Hello from detector',
            severity: 'info',
            metadata: {
                address: ctx.address,
                contractsDetected: contractCount,
            },
        }];
    }
};


