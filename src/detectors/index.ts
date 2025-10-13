export interface DetectorFinding {
    id: string;
    title: string;
    description?: string;
    severity?: 'info' | 'low' | 'medium' | 'high' | 'critical';
    metadata?: Record<string, any>;
}

export interface DetectorContext {
    address: string;
    slither: any; // parsed slither JSON
}

export interface Detector {
    name: string;
    run(ctx: DetectorContext): DetectorFinding[] | Promise<DetectorFinding[]>;
}

export function runDetectors(ctx: DetectorContext, detectors: Detector[]): Promise<DetectorFinding[]> {
    return Promise.all(detectors.map(d => Promise.resolve(d.run(ctx)))).then(parts => parts.flat());
}


