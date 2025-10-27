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
    sources?: Record<string, string>;
    bytecode?: string;
}

export interface Detector {
    name: string;
    run(ctx: DetectorContext): DetectorFinding[] | Promise<DetectorFinding[]>;
}

export function runDetectors(ctx: DetectorContext, detectors: Detector[]): Promise<DetectorFinding[]> {
    return Promise.all(detectors.map(d => Promise.resolve(d.run(ctx)))).then(parts => parts.flat());
}

// Simple registry utility
import { HelloDetector } from './hello';
import { UnprotectedSelfdestructDetector } from './unprotectedSelfdestruct';

export const ALL_DETECTORS: Record<string, Detector> = {
    hello: HelloDetector,
    selfdestruct: UnprotectedSelfdestructDetector,
};

export function selectDetectors(keys?: string[]): Detector[] {
    if (!keys || keys.length === 0) return Object.values(ALL_DETECTORS);
    const out: Detector[] = [];
    for (const k of keys) {
        const d = ALL_DETECTORS[k];
        if (d) out.push(d);
    }
    return out;
}


