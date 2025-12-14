import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';
import { ethers } from 'ethers';

function isZeroHex(hex?: string): boolean {
    if (!hex) return true;
    if (!hex.startsWith('0x')) return false;
    const clean = hex.slice(2);
    if (clean.length === 0) return true;
    return /^0+$/.test(clean);
}

function parseAddressFromWord(word?: string): string | undefined {
    if (!word || !word.startsWith('0x')) return undefined;
    const clean = word.slice(2).padStart(64, '0');
    const addrHex = clean.slice(-40);
    const addr = ('0x' + addrHex).toLowerCase();
    if (/^0x0+$/.test(addr)) return undefined;
    return addr;
}

async function getStorageSlot(
    provider: ethers.Provider,
    address: string,
    slotHex: string
): Promise<string> {
    try {
        const hex: string = await (provider as any).send('eth_getStorageAt', [address, slotHex, 'latest']);
        return typeof hex === 'string' ? hex : '0x';
    } catch {
        return '0x';
    }
}

type DisassembledOp = { pc: number; op: string; pushData?: string };

function hexToBytes(hex?: string): Uint8Array {
    if (!hex || hex === '0x') return new Uint8Array(0);
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

function opcodeName(op: number): string {
    const table: Record<number, string> = {
        0x00: 'STOP',
        0x01: 'ADD',
        0x14: 'EQ',
        0x33: 'CALLER',
        0x54: 'SLOAD',
        0x55: 'SSTORE',
        0x56: 'JUMP',
        0x57: 'JUMPI',
        0xfd: 'REVERT',
        0xff: 'SELFDESTRUCT',
    };
    return table[op] || `OP_0x${op.toString(16)}`;
}

function disassemble(bytecode?: string): DisassembledOp[] {
    const bytes = hexToBytes(bytecode);
    const ops: DisassembledOp[] = [];
    let pc = 0;
    while (pc < bytes.length) {
        const opcode = bytes[pc];
        const isPush = opcode >= 0x60 && opcode <= 0x7f;
        if (isPush) {
            const pushLen = opcode - 0x60 + 1;
            const start = pc + 1;
            const end = Math.min(start + pushLen, bytes.length);
            const data = bytes.slice(start, end);
            ops.push({ pc, op: `PUSH${pushLen}`, pushData: `0x${Buffer.from(data).toString('hex')}` });
            pc = end;
            continue;
        }
        const name = opcodeName(opcode);
        ops.push({ pc, op: name });
        pc += 1;
    }
    return ops;
}

function isZeroSlotPush(op: DisassembledOp): boolean {
    if (!op.op.startsWith('PUSH')) return false;
    const data = op.pushData || '';
    if (!data.startsWith('0x')) return false;
    const clean = data.slice(2);
    if (clean.length === 0) return true;
    return /^0+$/.test(clean);
}

function analyzeSlot0InitializerFromBytecode(ops: DisassembledOp[]) {
    let hasSlot0Write = false;
    let hasSlot0WriteProtected = false;
    let hasSlot0WriteUnprotected = false;

    for (let i = 0; i < ops.length; i++) {
        if (ops[i].op !== 'SSTORE') continue;

        // 向前查看少量窗口，看是否有 PUSH 0x00 作为 slot key（代表写入 slot 0）
        const lookbackStart = Math.max(0, i - 3);
        let isSlot0 = false;
        for (let j = i - 1; j >= lookbackStart; j--) {
            if (isZeroSlotPush(ops[j])) {
                isSlot0 = true;
                break;
            }
        }
        if (!isSlot0) continue;

        hasSlot0Write = true;

        // 在更大的窗口里寻找类似访问控制模式：CALLER + EQ + (JUMPI 或 REVERT)
        const winStart = Math.max(0, i - 32);
        const winEnd = Math.min(ops.length - 1, i + 16);
        let hasCaller = false;
        let hasEq = false;
        let hasGuard = false;

        for (let k = winStart; k <= winEnd; k++) {
            const opName = ops[k].op;
            if (opName === 'CALLER') hasCaller = true;
            else if (opName === 'EQ') hasEq = true;
            else if (opName === 'JUMPI' || opName === 'REVERT') hasGuard = true;
        }

        const hasAccessControl = hasCaller && hasEq && hasGuard;
        if (hasAccessControl) {
            hasSlot0WriteProtected = true;
        } else {
            hasSlot0WriteUnprotected = true;
        }
    }

    return { hasSlot0Write, hasSlot0WriteProtected, hasSlot0WriteUnprotected };
}

function analyzeSelfdestructPatterns(ops: DisassembledOp[]) {
    let hasSelfdestruct = false;
    let hasSelfdestructGuarded = false;

    for (let i = 0; i < ops.length; i++) {
        if (ops[i].op !== 'SELFDESTRUCT') continue;
        hasSelfdestruct = true;

        const winStart = Math.max(0, i - 32);
        const winEnd = Math.min(ops.length - 1, i + 8);
        let hasCaller = false;
        let hasEq = false;
        let hasGuard = false;

        for (let k = winStart; k <= winEnd; k++) {
            const opName = ops[k].op;
            if (opName === 'CALLER') hasCaller = true;
            else if (opName === 'EQ') hasEq = true;
            else if (opName === 'JUMPI' || opName === 'REVERT') hasGuard = true;
        }

        if (hasCaller && hasEq && hasGuard) {
            hasSelfdestructGuarded = true;
        }
    }

    return { hasSelfdestruct, hasSelfdestructGuarded };
}

export const LibraryMisuseNoSourcePairDetector: PairDetector = {
    name: 'library-misuse',
    async run(ctx: PairDetectorContext): Promise<PairDetectorFinding[]> {
        const findings: PairDetectorFinding[] = [];

        const rpcUrl = process.env.RPC_URL ||  'http://localhost:8547';
        const provider = new ethers.JsonRpcProvider(rpcUrl);

        const proxy = ctx.proxy.address.toLowerCase();
        const logic = ctx.logic.address.toLowerCase();

        const proxyBytecode = (ctx.proxy as any).bytecode as string | undefined;
        const logicBytecode = (ctx.logic as any).bytecode as string | undefined;

        if (!proxyBytecode || !logicBytecode) {
            findings.push({
                id: 'library-misuse-nosource-missing-bytecode',
                title: 'library-misuse (NO_SOURCE): bytecode not available for proxy or logic',
                severity: 'info',
                metadata: {
                    proxyAddress: proxy,
                    logicAddress: logic,
                    proxyHasBytecode: !!proxyBytecode,
                    logicHasBytecode: !!logicBytecode,
                    note: 'Run with NO_SOURCE=1 so that proxy/logic bytecode is populated.',
                } as any,
            });
            return findings;
        }

        // --- 阶段一：通过 EIP-1967 槽确认 proxy -> logic，并检查 logic 槽 0 状态 ---
        const EIP1967_IMPLEMENTATION_SLOT =
            '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

        const implWord = await getStorageSlot(provider, proxy, EIP1967_IMPLEMENTATION_SLOT);
        const logicFromSlot = parseAddressFromWord(implWord);
        const implSlotResolved = !!logicFromSlot;
        const implMatches = !!(logicFromSlot && logicFromSlot === logic);

        const logicSlot0 = await getStorageSlot(provider, logic, '0x0');
        const logicSlot0IsZero = isZeroHex(logicSlot0);

        // --- 阶段二：对 logic 字节码做启发式分析 ---
        const logicOps = disassemble(logicBytecode);
        const slot0Init = analyzeSlot0InitializerFromBytecode(logicOps);
        const sdPatterns = analyzeSelfdestructPatterns(logicOps);

        const hasUnprotectedSlot0Init = slot0Init.hasSlot0WriteUnprotected;
        const hasAnySlot0Init = slot0Init.hasSlot0Write;
        const hasSelfdestruct = sdPatterns.hasSelfdestruct;
        const hasSelfdestructGuarded = sdPatterns.hasSelfdestructGuarded;

        const parityLikePattern = hasUnprotectedSlot0Init && hasSelfdestructGuarded;

        // --- 严重性综合 ---
        let severity: PairDetectorFinding['severity'] = 'info';
        let id = 'library-misuse-nosource-info';
        let title = 'library-misuse (NO_SOURCE): no clear Parity-style pattern detected';

        if (parityLikePattern && logicSlot0IsZero) {
            severity = 'critical';
            id = 'library-misuse-nosource-parity-critical';
            title =
                'Logic contract appears uninitialized at slot 0 and bytecode shows unprotected slot0 initializer with guarded selfdestruct path (Parity-style library misuse)';
        } else if ((parityLikePattern && !logicSlot0IsZero) || (logicSlot0IsZero && (hasAnySlot0Init || hasSelfdestruct))) {
            severity = 'high';
            id = 'library-misuse-nosource-parity-high';
            title =
                'Logic contract shows strong Parity-style signals (slot0 initializer and/or selfdestruct) with suspicious slot 0 state; manual confirmation recommended';
        } else if (hasUnprotectedSlot0Init || hasSelfdestructGuarded) {
            severity = 'medium';
            id = 'library-misuse-nosource-suspicious';
            title =
                'Logic contract bytecode shows suspicious initializer or selfdestruct patterns; library misuse risk cannot be ruled out';
        }

        findings.push({
            id,
            title,
            severity,
            metadata: {
                proxyAddress: proxy,
                logicAddress: logic,
                eip1967ImplSlotWord: implWord,
                eip1967ImplResolved: implSlotResolved,
                eip1967ImplMatchesLogicParam: implMatches,
                logicSlot0,
                logicSlot0IsZero,
                bytecodePatterns: {
                    slot0Init,
                    selfdestruct: sdPatterns,
                },
                notes: {
                    description:
                        'NO_SOURCE parity-style library misuse heuristic: confirm proxy->logic via EIP-1967, check logic slot 0 state, then scan bytecode for unprotected writes to slot 0 and selfdestruct guarded by caller/eq/jump.',
                },
            } as any,
        });

        return findings;
    },
};


