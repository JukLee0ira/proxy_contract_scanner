import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';
import { ethers } from 'ethers';

function isZeroAddress(addr?: string | null): boolean {
    if (!addr) return true;
    const a = addr.toLowerCase();
    return a === '0x0000000000000000000000000000000000000000';
}

async function tryReadAdminLike(
    provider: ethers.Provider,
    target: string
): Promise<{ kind: 'owner' | 'admin' | 'unknown'; value?: string }>{
    const candidates: { kind: 'owner' | 'admin'; fragment: string; fn: string }[] = [
        { kind: 'owner', fragment: 'function owner() view returns (address)', fn: 'owner' },
        { kind: 'admin', fragment: 'function admin() view returns (address)', fn: 'admin' },
        { kind: 'owner', fragment: 'function getOwner() view returns (address)', fn: 'getOwner' },
    ];

    for (const c of candidates) {
        try {
            const iface = new ethers.Interface([c.fragment]);
            const data = iface.encodeFunctionData(c.fn, []);
            const raw = await provider.call({ to: target, data });
            if (!raw || raw === '0x') continue;
            const decoded = iface.decodeFunctionResult(c.fn, raw);
            const addr = (decoded[0] as string) || '';
            return { kind: c.kind, value: addr.toLowerCase() };
        } catch {
            // ignore and try next candidate
        }
    }

    return { kind: 'unknown' };
}

function concatSources(sources?: Record<string, string>): string {
    if (!sources) return '';
    return Object.values(sources).join('\n\n');
}

interface FunctionPattern {
    name: string;
    isInitializer: boolean;
    writesOwner: boolean;
    hasAccessControl: boolean;
}

interface SourceAnalysis {
    hasSelfdestruct: boolean;
    hasOwnerVar: boolean;
    initPatterns: FunctionPattern[];
    killPatterns: FunctionPattern[];
}

function analyzeSource(source?: string): SourceAnalysis {
    if (!source) {
        return {
            hasSelfdestruct: false,
            hasOwnerVar: false,
            initPatterns: [],
            killPatterns: [],
        };
    }

    const text = source.toLowerCase();

    const hasSelfdestruct =
        /selfdestruct\s*\(/i.test(source) || /\bsuicide\s*\(/i.test(source);

    const hasOwnerVar =
        /\baddress\s+(public|private|internal|external)?\s*[_a-z0-9]*owner\b/i.test(source) ||
        text.includes('ownable');

    const initPatterns: FunctionPattern[] = [];
    const killPatterns: FunctionPattern[] = [];

    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const fnMatch =
            /function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*(public|external|internal|private)?/i.exec(
                line
            );
        if (!fnMatch) continue;

        const fnName = fnMatch[1];
        const visibility = (fnMatch[3] || '').toLowerCase();
        const sigLine = line + (lines[i + 1] || '');
        const bodyWindow = lines.slice(i, Math.min(lines.length, i + 20)).join('\n');

        const hasOnlyOwner =
            /onlyowner\b/i.test(sigLine) ||
            /onlywallet\b/i.test(sigLine) ||
            /onlyadmin\b/i.test(sigLine) ||
            /onlyrole\b/i.test(sigLine);
        const hasInitializerMod =
            /\binitializer\b/i.test(sigLine) || /\breinitializer\b/i.test(sigLine);

        const writesOwner =
            /\bowner\s*=\s*/i.test(bodyWindow) ||
            /\b_owner\s*=\s*/i.test(bodyWindow) ||
            /\btransferownership\s*\(/i.test(bodyWindow);

        const usesSelfdestruct =
            /selfdestruct\s*\(/i.test(bodyWindow) || /\bsuicide\s*\(/i.test(bodyWindow);

        const hasAccessControl = hasOnlyOwner || hasInitializerMod;

        const isInitName =
            /\binit\b/i.test(fnName) ||
            /\binitialize\b/i.test(fnName) ||
            /\binitwallet\b/i.test(fnName);

        const isPublicOrExternal =
            visibility === '' || visibility === 'public' || visibility === 'external';

        if (isInitName && isPublicOrExternal) {
            initPatterns.push({
                name: fnName,
                isInitializer: true,
                writesOwner,
                hasAccessControl,
            });
        }

        if (usesSelfdestruct) {
            killPatterns.push({
                name: fnName,
                isInitializer: false,
                writesOwner: false,
                hasAccessControl,
            });
        }
    }

    return { hasSelfdestruct, hasOwnerVar, initPatterns, killPatterns };
}

export const LibraryMisusePairDetector: PairDetector = {
    name: 'library_misuse',
    async run(ctx: PairDetectorContext): Promise<PairDetectorFinding[]> {
        const findings: PairDetectorFinding[] = [];

        const rpcUrl = process.env.RPC_URL || process.env.ETH_RPC_URL || 'http://localhost:8547';
        const provider = new ethers.JsonRpcProvider(rpcUrl);

        const proxy = ctx.proxy.address.toLowerCase();
        const logic = ctx.logic.address.toLowerCase();

        // --- 阶段二：静态源码启发式分析（对 proxy 和 logic 都做一次） ---
        const proxySource = concatSources(ctx.proxy.sources);
        const logicSource = concatSources(ctx.logic.sources);

        const proxyAnalysis = analyzeSource(proxySource);
        const logicAnalysis = analyzeSource(logicSource);

        const computeFlags = (a: SourceAnalysis) => {
            const hasUnprotectedInitOwner = a.initPatterns.some(
                (p) => p.writesOwner && !p.hasAccessControl
            );
            const hasDangerousDestructor = a.hasSelfdestruct && a.killPatterns.length > 0;
            const patternCritical = hasUnprotectedInitOwner && hasDangerousDestructor;
            const patternHigh = hasUnprotectedInitOwner || hasDangerousDestructor;
            return { hasUnprotectedInitOwner, hasDangerousDestructor, patternCritical, patternHigh };
        };

        const proxyFlags = computeFlags(proxyAnalysis);
        const logicFlags = computeFlags(logicAnalysis);

        // 选择“最像库合约”的一方，用于链上 owner/admin 读取
        type Candidate = {
            role: 'proxy' | 'logic';
            address: string;
            analysis: SourceAnalysis;
            flags: ReturnType<typeof computeFlags>;
        };

        const candidates: Candidate[] = [
            { role: 'proxy', address: proxy, analysis: proxyAnalysis, flags: proxyFlags },
            { role: 'logic', address: logic, analysis: logicAnalysis, flags: logicFlags },
        ];

        let libraryCandidate = candidates[0];
        for (const c of candidates.slice(1)) {
            if (c.flags.patternCritical && !libraryCandidate.flags.patternCritical) {
                libraryCandidate = c;
            } else if (
                c.flags.patternHigh &&
                !libraryCandidate.flags.patternCritical &&
                !libraryCandidate.flags.patternHigh
            ) {
                libraryCandidate = c;
            }
        }

        // --- 阶段一：链上状态检查（对“最像库”的那个地址读 owner/admin） ---
        const adminLike = await tryReadAdminLike(provider, libraryCandidate.address);
        const hasAdminLike = adminLike.kind !== 'unknown' && !!adminLike.value;
        const adminIsZero = hasAdminLike && isZeroAddress(adminLike.value);

        // 汇总整体模式强度（任意一方出现就算）
        const patternCritical = proxyFlags.patternCritical || logicFlags.patternCritical;
        const patternHigh = proxyFlags.patternHigh || logicFlags.patternHigh;

        // --- 组合结论 ---
        // 只要有一边出现「未受保护的初始化 + 自毁路径」，就认为有 Parity 风格模式；
        // 再结合“libraryCandidate”的链上 owner/admin 状态来定级。
        let severity: PairDetectorFinding['severity'] = 'info';
        let id = 'library-misuse-info';
        let title = 'library_misuse: no clear Parity-style pattern detected';

        const adminUnknown = !hasAdminLike;

        if (patternCritical && adminIsZero) {
            severity = 'critical';
            id = 'library-misuse-uninitialized-logic-critical';
            title =
                'Library/logic contract appears uninitialized (owner/admin is zero) with unprotected initializer and selfdestruct path (Parity-style library misuse)';
        } else if (patternCritical && (adminUnknown || !adminIsZero)) {
            severity = 'high';
            id = 'library-misuse-parity-pattern-high';
            title =
                'Library/logic contract shows Parity-style pattern: unprotected initializer that sets owner and a selfdestruct path; check on-chain owner/admin';
        } else if (patternHigh && adminIsZero) {
            severity = 'high';
            id = 'library-misuse-uninitialized-logic-high';
            title =
                'Library/logic contract admin-like address is zero and dangerous patterns are present; library misuse risk is high';
        } else if (patternHigh && (adminUnknown || !adminIsZero)) {
            severity = 'medium';
            id = 'library-misuse-dangerous-patterns';
            title =
                'Library/logic contract shows suspicious initializer or selfdestruct patterns; current owner/admin is non-zero or unknown';
        } else if (adminIsZero) {
            severity = 'medium';
            id = 'library-misuse-uninitialized-logic-medium';
            title =
                'Library/logic contract admin-like address is zero without clear Parity-style pattern; manual review recommended';
        }

        findings.push({
            id,
            title,
            severity,
            metadata: {
                proxyAddress: proxy,
                logicAddress: logic,
                libraryCandidateRole: libraryCandidate.role,
                libraryCandidateAddress: libraryCandidate.address,
                adminLikeKind: adminLike.kind,
                adminLikeAddress: adminLike.value,
                adminIsZero,
                hasSelfdestruct: proxyAnalysis.hasSelfdestruct || logicAnalysis.hasSelfdestruct,
                hasOwnerVar: proxyAnalysis.hasOwnerVar || logicAnalysis.hasOwnerVar,
                proxyPatterns: {
                    hasSelfdestruct: proxyAnalysis.hasSelfdestruct,
                    hasOwnerVar: proxyAnalysis.hasOwnerVar,
                    initPatterns: proxyAnalysis.initPatterns,
                    killPatterns: proxyAnalysis.killPatterns.map((k) => ({
                        name: k.name,
                        hasAccessControl: k.hasAccessControl,
                    })),
                },
                logicPatterns: {
                    hasSelfdestruct: logicAnalysis.hasSelfdestruct,
                    hasOwnerVar: logicAnalysis.hasOwnerVar,
                    initPatterns: logicAnalysis.initPatterns,
                    killPatterns: logicAnalysis.killPatterns.map((k) => ({
                        name: k.name,
                        hasAccessControl: k.hasAccessControl,
                    })),
                },
                notes: {
                    description:
                        'Heuristic detector for Parity-style library misuse: scans both proxy and logic for unprotected initializer that sets owner and a selfdestruct path, then checks the likely library contract owner/admin on-chain.',
                },
            } as any,
        });

        return findings;
    },
};


