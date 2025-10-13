export interface PairDetectorFinding {
    id: string;
    title: string;
    description?: string;
    severity?: 'info' | 'low' | 'medium' | 'high' | 'critical';
    metadata?: Record<string, any>;
}

export interface PairDetectorContext {
    proxy: { address: string; slither: any; sources?: Record<string, string> };
    logic: { address: string; slither: any; sources?: Record<string, string> };
}

export interface PairDetector {
    name: string;
    run(ctx: PairDetectorContext): PairDetectorFinding[] | Promise<PairDetectorFinding[]>;
}

export function runPairDetectors(ctx: PairDetectorContext, detectors: PairDetector[]): Promise<PairDetectorFinding[]> {
    return Promise.all(detectors.map(d => Promise.resolve(d.run(ctx)))).then(parts => parts.flat());
}


