import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';
import { ethers } from 'ethers';

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

function opcodeName(op: number): string {
    const table: Record<number, string> = {
        0x00: 'STOP',
        0x01: 'ADD',
        0x02: 'MUL',
        0x03: 'SUB',
        0x04: 'DIV',
        0x05: 'SDIV',
        0x10: 'LT',
        0x11: 'GT',
        0x12: 'SLT',
        0x13: 'SGT',
        0x14: 'EQ',
        0x15: 'ISZERO',
        0x16: 'AND',
        0x17: 'OR',
        0x18: 'XOR',
        0x19: 'NOT',
        0x1a: 'BYTE',
        0x1b: 'SHL',
        0x1c: 'SHR',
        0x1d: 'SAR',
        0x33: 'CALLER',
        0x35: 'CALLDATALOAD',
        0x36: 'CALLDATASIZE',
        0x37: 'CALLDATACOPY',
        0x39: 'CODESIZE',
        0x3b: 'EXTCODESIZE',
        0x3d: 'RETURNDATASIZE',
        0x3e: 'RETURNDATACOPY',
        0x50: 'POP',
        0x51: 'MLOAD',
        0x52: 'MSTORE',
        0x53: 'MSTORE8',
        0x54: 'SLOAD',
        0x55: 'SSTORE',
        0x56: 'JUMP',
        0x57: 'JUMPI',
        0x58: 'PC',
        0x59: 'MSIZE',
        0x5b: 'JUMPDEST',
        0x80: 'DUP1', 0x81: 'DUP2', 0x82: 'DUP3', 0x83: 'DUP4', 0x84: 'DUP5',
        0x85: 'DUP6', 0x86: 'DUP7', 0x87: 'DUP8', 0x88: 'DUP9', 0x89: 'DUP10',
        0x8a: 'DUP11', 0x8b: 'DUP12', 0x8c: 'DUP13', 0x8d: 'DUP14', 0x8e: 'DUP15', 0x8f: 'DUP16',
        0x90: 'SWAP1', 0x91: 'SWAP2', 0x92: 'SWAP3', 0x93: 'SWAP4', 0x94: 'SWAP5',
        0x95: 'SWAP6', 0x96: 'SWAP7', 0x97: 'SWAP8', 0x98: 'SWAP9', 0x99: 'SWAP10',
        0x9a: 'SWAP11', 0x9b: 'SWAP12', 0x9c: 'SWAP13', 0x9d: 'SWAP14', 0x9e: 'SWAP15', 0x9f: 'SWAP16',
        0xf3: 'RETURN',
        0xfd: 'REVERT',
        0xfe: 'INVALID',
    };
    return table[op] || `OP_0x${op.toString(16)}`;
}

function isZeroHex(hex?: string): boolean {
    if (!hex) return true;
    if (!hex.startsWith('0x')) return false;
    const clean = hex.slice(2);
    if (clean.length === 0) return true;
    return /^0+$/.test(clean);
}

function isSmallHexEq(hex: string | undefined, value: number): boolean {
    if (!hex) return false;
    const v = parseInt((hex.startsWith('0x') ? hex.slice(2) : hex) || '0', 16);
    return v === value;
}

function sliceWindow(bytecode: string | undefined, startPc: number, endPc: number): string | undefined {
    if (!bytecode || bytecode === '0x') return undefined;
    const clean = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
    const start = Math.max(0, startPc * 2);
    const end = Math.min(clean.length, endPc * 2);
    if (end <= start) return undefined;
    return '0x' + clean.slice(start, end);
}

function findSstoreSlot0(ops: DisassembledOp[], bytecode?: string): { has: boolean; windows: string[] } {
    const windows: string[] = [];
    for (let i = 0; i < ops.length; i++) {
        if (ops[i].op !== 'SSTORE') continue;
        // Look back a short window for PUSHx 0x00 as slot key
        const start = Math.max(0, i - 3);
        for (let j = i - 1; j >= start; j--) {
            const o = ops[j];
            if (o.op.startsWith('PUSH') && isZeroHex(o.pushData)) {
                const win = sliceWindow(bytecode, ops[start].pc, ops[Math.min(i + 2, ops.length - 1)].pc + 1);
                if (win) windows.push(win);
                break;
            }
        }
    }
    return { has: windows.length > 0, windows };
}

function findPackedReadsFromSlot0(ops: DisassembledOp[], bytecode?: string): {
    hasLowByte: boolean;
    hasSecondByte: boolean;
    windowsLow: string[];
    windowsSecond: string[];
    hasGuardPattern: boolean;
} {
    let hasLowByte = false;
    let hasSecondByte = false;
    const windowsLow: string[] = [];
    const windowsSecond: string[] = [];
    let hasGuardPattern = false;

    const isTrivial = (op: string) => op.startsWith('DUP') || op.startsWith('SWAP') || op === 'POP';

    for (let i = 0; i < ops.length; i++) {
        // Pattern anchor: PUSH 0x00 ; SLOAD
        if (!(ops[i].op.startsWith('PUSH') && isZeroHex(ops[i].pushData))) continue;
        if (i + 1 >= ops.length || ops[i + 1].op !== 'SLOAD') continue;

        // Scan small forward window for AND 0xff (low byte)
        const forwardEnd = Math.min(ops.length, i + 10);
        for (let k = i + 2; k < forwardEnd; k++) {
            const o = ops[k];
            if (o.op === 'AND') {
                // Check immediate before AND there's PUSH with 0xff (or 0x..ff)
                const prev = ops[k - 1];
                if (prev && prev.op.startsWith('PUSH') && isSmallHexEq(prev.pushData, 0xff)) {
                    hasLowByte = true;
                    const win = sliceWindow(bytecode, ops[i].pc, ops[Math.min(k + 1, ops.length - 1)].pc + 1);
                    if (win) windowsLow.push(win);
                    break;
                }
            }
        }

        // Scan for second byte: SHR 0x08 + AND 0xff OR DIV 0x100 + AND 0xff
        for (let k = i + 2; k < forwardEnd; k++) {
            const o = ops[k];
            if ((o.op === 'SHR' || o.op === 'DIV')) {
                const prev = ops[k - 1];
                const shr8 = o.op === 'SHR' && prev && prev.op.startsWith('PUSH') && isSmallHexEq(prev.pushData, 0x08);
                const div100 = o.op === 'DIV' && prev && prev.op.startsWith('PUSH') && isSmallHexEq(prev.pushData, 0x100);
                if (shr8 || div100) {
                    // Look ahead for AND 0xff within small window
                    for (let m = k + 1; m < Math.min(ops.length, k + 5); m++) {
                        if (isTrivial(ops[m].op)) continue;
                        if (ops[m].op === 'AND') {
                            const prev2 = ops[m - 1];
                            if (prev2 && prev2.op.startsWith('PUSH') && isSmallHexEq(prev2.pushData, 0xff)) {
                                hasSecondByte = true;
                                const win = sliceWindow(bytecode, ops[i].pc, ops[Math.min(m + 1, ops.length - 1)].pc + 1);
                                if (win) windowsSecond.push(win);
                            }
                        }
                    }
                }
            }
        }

        // Optional guard: nearby JUMPI or REVERT after reads
        for (let k = i + 2; k < forwardEnd; k++) {
            if (ops[k].op === 'JUMPI' || ops[k].op === 'REVERT') {
                hasGuardPattern = true;
                break;
            }
        }
    }

    return { hasLowByte, hasSecondByte, windowsLow, windowsSecond, hasGuardPattern };
}

function detectStorageCollisionFromBytecode(proxyBytecode?: string, logicBytecode?: string) {
    const proxyOps = disassemble(proxyBytecode);
    const logicOps = disassemble(logicBytecode);
    const proxySig = findSstoreSlot0(proxyOps, proxyBytecode);
    const logicSig = findPackedReadsFromSlot0(logicOps, logicBytecode);
    return {
        proxy: proxySig,
        logic: logicSig,
    };
}

function concatSources(sources?: Record<string, string>): string {
    if (!sources) return '';
    return Object.values(sources).join('\n\n');
}

function detectUnstructuredStoragePattern(proxySourceText: string): boolean {
    if (!proxySourceText) return false;
    const text = proxySourceText.toLowerCase();
    return text.includes('eip-1967') ||
        text.includes('_admin_slot') ||
        text.includes('_implementation_slot') ||
        /bytes32\s+constant\s+_[a-z_]*slot/.test(proxySourceText);
}

function countProxyStateVariablesHeuristic(proxySourceText: string): number {
    if (!proxySourceText) return 0;
    // Very rough heuristic: count likely state variable declarations excluding constants/immutables
    const regex = /\b(bool|address|uint(?:8|16|32|64|128|256)?)\s+(?:public|private|internal|external)?\s*[_A-Za-z][A-Za-z0-9_]*\s*(?:=\s*[^;]+)?\s*;/g;
    const constOrImmutable = /\b(constant|immutable)\b/;
    let count = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(proxySourceText)) !== null) {
        const decl = match[0];
        if (!constOrImmutable.test(decl)) count++;
    }
    return count;
}

function detectLogicInitializerPatterns(logicSourceText: string): { hasPackedBools: boolean; hasNumericInitialized: boolean } {
    const text = logicSourceText || '';
    const hasBoolInitialized = /\bbool\s+_?initialized\b/.test(text);
    const hasBoolInitializing = /\bbool\s+_?initializing\b/.test(text);
    const hasPackedBools = hasBoolInitialized || hasBoolInitializing;
    const hasNumericInitialized = /\buint(?:8|256)?\s+_?initialized\b/.test(text);
    return { hasPackedBools, hasNumericInitialized };
}

function parseByte(hexWord: string, fromEndIndex: number): number {
    // hexWord like 0x[64 hex chars]; fromEndIndex: 0 = last byte, 1 = second last
    if (!hexWord || !hexWord.startsWith('0x')) return 0;
    const clean = hexWord.slice(2);
    const start = clean.length - (fromEndIndex + 1) * 2;
    if (start < 0) return 0;
    const byteHex = clean.slice(start, start + 2) || '00';
    return parseInt(byteHex, 16);
}

async function getStorageSlot0(provider: ethers.Provider, address: string): Promise<string> {
    const slotHex = '0x0';
    try {
        // Use raw RPC for compatibility across ethers versions
        const hex: string = await (provider as any).send('eth_getStorageAt', [address, slotHex, 'latest']);
        return typeof hex === 'string' ? hex : '0x';
    } catch {
        return '0x';
    }
}

export const StorageCollisionPairDetector: PairDetector = {
    name: 'storage-collision',
    async run(ctx: PairDetectorContext): Promise<PairDetectorFinding[]> {
        const findings: PairDetectorFinding[] = [];

        // NO_SOURCE stub: placeholder for bytecode-only analysis
        const proxyHasSrc = !!(ctx.proxy.sources && Object.values(ctx.proxy.sources).some((c) => (c || '').trim().length > 0));
        const logicHasSrc = !!(ctx.logic.sources && Object.values(ctx.logic.sources).some((c) => (c || '').trim().length > 0));
        const proxyBytecode = (ctx.proxy as any).bytecode as string | undefined;
        const logicBytecode = (ctx.logic as any).bytecode as string | undefined;
        if ((!proxyHasSrc && !logicHasSrc) && (proxyBytecode || logicBytecode)) {
            const analysis = detectStorageCollisionFromBytecode(proxyBytecode, logicBytecode);

            const rpcUrl = process.env.RPC_URL ||  'http://localhost:8547';
            const provider = new ethers.JsonRpcProvider(rpcUrl);
            const slot0 = await getStorageSlot0(provider, ctx.proxy.address);
            const eip1967AdminSlot = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
            let eipAdmin = '0x';
            try {
                eipAdmin = await (provider as any).send('eth_getStorageAt', [ctx.proxy.address, eip1967AdminSlot, 'latest']);
            } catch {
                eipAdmin = '0x';
            }

            const byte0 = parseByte(slot0, 0);
            const byte1 = parseByte(slot0, 1);
            const slot0NonZero = !isZeroHex(slot0);
            const eipAdminNonZero = !isZeroHex(eipAdmin);

            const logicHasBoth = analysis.logic.hasLowByte && analysis.logic.hasSecondByte;
            const logicHasAny = analysis.logic.hasLowByte || analysis.logic.hasSecondByte;

            let severity: 'high' | 'medium' | 'info' = 'info';
            let title = 'NO_SOURCE: storage collision bytecode analysis';
            let exploitationLikely = false;

            if (logicHasBoth && slot0NonZero && byte0 !== 0 && byte1 !== 0) {
                severity = 'high';
                exploitationLikely = true;
            } else if (logicHasAny || slot0NonZero) {
                severity = 'medium';
            }

            findings.push({
                id: exploitationLikely ? 'storage-collision-nosource-confirmed' : (severity === 'medium' ? 'storage-collision-nosource-partial' : 'storage-collision-nosource-info'),
                title,
                severity,
                metadata: {
                    proxyAddress: ctx.proxy.address,
                    logicAddress: ctx.logic.address,
                    slot0,
                    eip1967AdminSlot: eip1967AdminSlot,
                    eip1967AdminValue: eipAdmin,
                    byte0,
                    byte1,
                    proxyPatterns: {
                        hasSstoreSlot0: analysis.proxy.has,
                        windows: analysis.proxy.windows.slice(0, 3),
                    },
                    logicPatterns: {
                        hasLowByte: analysis.logic.hasLowByte,
                        hasSecondByte: analysis.logic.hasSecondByte,
                        hasGuardPattern: analysis.logic.hasGuardPattern,
                        windowsLow: analysis.logic.windowsLow.slice(0, 3),
                        windowsSecond: analysis.logic.windowsSecond.slice(0, 3),
                    },
                    notes: {
                        slot0NonZero,
                        eipAdminNonZero,
                        exploitationLikely,
                    },
                } as any,
            });
            return findings;
        }

        const proxySourceText = concatSources(ctx.proxy.sources);
        const logicSourceText = concatSources(ctx.logic.sources);

        const unstructured = detectUnstructuredStoragePattern(proxySourceText);
        const proxyVarCount = countProxyStateVariablesHeuristic(proxySourceText);
        const logicPatterns = detectLogicInitializerPatterns(logicSourceText);

        const stage1Potential = !unstructured && proxyVarCount > 0 && (logicPatterns.hasPackedBools || logicPatterns.hasNumericInitialized);

        findings.push({
            id: 'storage-collision-stage1',
            title: 'Storage collision: heuristic indicates potential risk (stage 1)',
            severity: stage1Potential ? 'high' : 'info',
            metadata: {
                proxyAddress: ctx.proxy.address,
                logicAddress: ctx.logic.address,
                proxy: { unstructured, proxyVarCount },
                logic: { hasPackedBools: logicPatterns.hasPackedBools, hasNumericInitialized: logicPatterns.hasNumericInitialized },
            } as any,
        });

        if (!stage1Potential) {
            return findings;
        }

        // Stage 2: On-chain state check on slot 0
        const rpcUrl = process.env.RPC_URL ||  'http://localhost:8547';
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        const slot0 = await getStorageSlot0(provider, ctx.proxy.address);

        const byte0 = parseByte(slot0, 0); // lowest-order byte
        const byte1 = parseByte(slot0, 1);

        let confirmed = false;
        let confirmationKind: 'packed-bools' | 'numeric-initialized' | undefined;
        let initializedBool = undefined as undefined | boolean;
        let initializingBool = undefined as undefined | boolean;
        let initializedNumericNonZero = undefined as undefined | boolean;

        if (logicPatterns.hasPackedBools) {
            initializedBool = byte0 !== 0;
            initializingBool = byte1 !== 0;
            // Heuristic: if either is polluted, initializer-style guards may be impacted
            if (initializedBool || initializingBool) {
                confirmed = true;
                confirmationKind = 'packed-bools';
            }
        }

        if (!confirmed && logicPatterns.hasNumericInitialized) {
            // If any non-zero in the word, consider initialized set
            const nonZero = /^0x0+$/.test(slot0) ? false : slot0 !== '0x' && slot0 !== '0x' + '0'.repeat(64);
            initializedNumericNonZero = nonZero;
            if (nonZero) {
                confirmed = true;
                confirmationKind = 'numeric-initialized';
            }
        }

        findings.push({
            id: confirmed ? 'storage-collision-confirmed' : 'storage-collision-unconfirmed',
            title: confirmed ? 'Storage collision: on-chain indicators present (stage 2)' : 'Storage collision: no on-chain indicators (stage 2)',
            severity: confirmed ? 'high' : 'low',
            metadata: {
                proxyAddress: ctx.proxy.address,
                logicAddress: ctx.logic.address,
                slot0Raw: slot0,
                byte0,
                byte1,
                confirmationKind,
                initializedBool,
                initializingBool,
                initializedNumericNonZero,
            } as any,
        });

        return findings;
    }
};


