import { Detector, DetectorContext, DetectorFinding } from './index';

function toSeverity(impact?: string): 'info' | 'low' | 'medium' | 'high' | 'critical' {
    const v = String(impact || '').toLowerCase();
    if (v.includes('critical')) return 'critical';
    if (v.includes('high')) return 'high';
    if (v.includes('medium')) return 'medium';
    if (v.includes('low')) return 'low';
    return 'info';
}

function includesSelfdestruct(text?: string): boolean {
    if (!text) return false;
    const t = text.toLowerCase();
    return t.includes('selfdestruct') || t.includes('suicidal');
}

export const UnprotectedSelfdestructDetector: Detector = {
    name: 'unprotected-selfdestruct',
    run(ctx: DetectorContext): DetectorFinding[] {
        const findings: DetectorFinding[] = [];
        // 0) Bytecode-only quick scan (NO_SOURCE mode): detect presence of SELFDESTRUCT opcode (0xFF)
        if (ctx.bytecode && typeof ctx.bytecode === 'string' && ctx.bytecode.length > 2) {
            const hex = ctx.bytecode.startsWith('0x') ? ctx.bytecode.slice(2) : ctx.bytecode;
            const n = hex.length;
            let i = 0;
            let hasSelfdestruct = false;
            while (i + 2 <= n) {
                const opcodeHex = hex.slice(i, i + 2);
                const opcode = parseInt(opcodeHex, 16);
                i += 2;
                if (Number.isNaN(opcode)) break;
                // PUSH1..PUSH32: 0x60..0x7f, skip immediate bytes
                if (opcode >= 0x60 && opcode <= 0x7f) {
                    const pushLen = opcode - 0x5f; // 1..32
                    i += pushLen * 2;
                    continue;
                }
                if (opcode === 0xff) { // SELFDESTRUCT
                    hasSelfdestruct = true;
                    break;
                }
            }
            if (hasSelfdestruct) {
                findings.push({
                    id: 'selfdestruct-bytecode',
                    title: 'selfdestruct opcode present in bytecode',
                    severity: 'info',
                    metadata: { address: ctx.address },
                });
            }
        }
        // 1) Quick source scan fallback: if any source contains selfdestruct, flag it as info
        if (ctx.sources) {
            for (const [file, content] of Object.entries(ctx.sources)) {
                if (includesSelfdestruct(content)) {
                    findings.push({
                        id: 'selfdestruct-source',
                        title: 'selfdestruct usage in source',
                        severity: 'info',
                        metadata: { address: ctx.address, file },
                    });
                }
            }
        }
        const results = (ctx.slither && ctx.slither.results) ? ctx.slither.results : undefined;
        const detectors: any[] = Array.isArray(results?.detectors) ? results!.detectors : [];

        for (const d of detectors) {
            const check = d?.check || d?.id || d?.name || '';
            const description = d?.description || d?.markdown || '';
            if (includesSelfdestruct(check) || includesSelfdestruct(description)) {
                const elements: any[] = Array.isArray(d?.elements) ? d.elements : [];
                const first = elements[0];
                const src = first?.source_mapping || first?.source_mapping_str || {};
                const file = src?.filename || src?.file || undefined;
                const start = src?.lines ? src.lines[0] : (src?.line || undefined);
                findings.push({
                    id: 'unprotected-selfdestruct',
                    title: d?.check || 'Unprotected selfdestruct',
                    severity: toSeverity(d?.impact || d?.severity),
                    metadata: {
                        address: ctx.address,
                        file,
                        line: start,
                        detector: d,
                    },
                });
            }
        }

        // 3) Fallback: if slither JSON contains the keyword but detector array missing
        if (findings.length === 0) {
            try {
                const j = JSON.stringify(ctx.slither).toLowerCase();
                if (j.includes('selfdestruct')) {
                    findings.push({
                        id: 'unprotected-selfdestruct-fallback',
                        title: 'selfdestruct usage detected (fallback)',
                        severity: 'info',
                        metadata: { address: ctx.address },
                    });
                }
            } catch {}
        }

        return findings;
    },
};


