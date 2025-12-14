import { PairDetector, PairDetectorContext, PairDetectorFinding } from './index';
import { ethers } from 'ethers';

function isZeroHex(hex?: string): boolean {
    if (!hex) return true;
    if (!hex.startsWith('0x')) return false;
    const clean = hex.slice(2);
    if (clean.length === 0) return true;
    return /^0+$/.test(clean);
}

async function getStorageSlot(address: string, slotHex: string, provider: ethers.Provider): Promise<string> {
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

function normalizeSlotHex(slot: string): string {
    const clean = (slot || '').toLowerCase().replace(/^0x/, '');
    if (!clean) return '';
    return '0x' + clean.padStart(64, '0');
}

function analyzeBeaconInitializerFromBytecode(bytecode: string | undefined, beaconSlot: string) {
    const ops = disassemble(bytecode);
    const target = normalizeSlotHex(beaconSlot);

    let hasWrite = false;
    let hasProtected = false;
    let hasUnprotected = false;

    for (let i = 0; i < ops.length; i++) {
        const o = ops[i];
        if (!o.op.startsWith('PUSH')) continue;
        if (!o.pushData) continue;
        if (normalizeSlotHex(o.pushData) !== target) continue;

        // 在附近寻找 SSTORE，认为这是一次对 beacon 槽的写入
        let sstoreIndex = -1;
        for (let j = i + 1; j < Math.min(ops.length, i + 16); j++) {
            if (ops[j].op === 'SSTORE') {
                sstoreIndex = j;
                break;
            }
        }
        if (sstoreIndex === -1) continue;

        hasWrite = true;

        const winStart = Math.max(0, i - 32);
        const winEnd = Math.min(ops.length - 1, sstoreIndex + 16);

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
            hasProtected = true;
        } else {
            hasUnprotected = true;
        }
    }

    return { hasWrite, hasProtected, hasUnprotected };
}

export const MixingPatternsPairDetector: PairDetector = {
    name: 'mixing_patterns',
    async run(ctx: PairDetectorContext): Promise<PairDetectorFinding[]> {
        const findings: PairDetectorFinding[] = [];

        const proxyBytecode = (ctx.proxy as any).bytecode as string | undefined;

        // 目前仅在 NO_SOURCE=1（bytecode-only）场景下工作
        if (!proxyBytecode) {
            findings.push({
                id: 'mixing-patterns-source-mode-not-implemented',
                title: 'mixing_patterns: currently only implemented for NO_SOURCE=1 (bytecode-only)',
                severity: 'info',
                metadata: {
                    proxyAddress: ctx.proxy.address,
                    logicAddress: ctx.logic.address,
                } as any,
            });
            return findings;
        }

        const rpcUrl = process.env.RPC_URL ||  'http://localhost:8547';
        const provider = new ethers.JsonRpcProvider(rpcUrl);

        // EIP-1967 标准槽位
        const EIP1967_IMPLEMENTATION_SLOT =
            '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
        const EIP1967_ADMIN_SLOT =
            '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
        const EIP1967_BEACON_SLOT =
            '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

        const [implWord, adminWord, beaconWord] = await Promise.all([
            getStorageSlot(ctx.proxy.address, EIP1967_IMPLEMENTATION_SLOT, provider),
            getStorageSlot(ctx.proxy.address, EIP1967_ADMIN_SLOT, provider),
            getStorageSlot(ctx.proxy.address, EIP1967_BEACON_SLOT, provider),
        ]);

        const implZero = isZeroHex(implWord);
        const adminZero = isZeroHex(adminWord);
        const beaconZero = isZeroHex(beaconWord);

        const appearsEip1967 = !implZero || !adminZero || !beaconZero;

        // 如果看起来不是 EIP-1967 代理，直接给一个中等风险提示并退出
        if (!appearsEip1967) {
            findings.push({
                id: 'mixing-patterns-non-eip1967',
                title: 'Proxy does not appear to follow EIP-1967 slots; skipping mixing_patterns (NO_SOURCE)',
                severity: 'medium',
                metadata: {
                    proxyAddress: ctx.proxy.address,
                    logicAddress: ctx.logic.address,
                    implementationSlot: implWord,
                    adminSlot: adminWord,
                    beaconSlot: beaconWord,
                    notes:
                        'mixing_patterns (NO_SOURCE) only considers standard EIP-1967 proxies due to resource constraints. ' +
                        'This proxy does not seem to use the standard implementation/admin/beacon slots. Manual review recommended.',
                } as any,
            });
            return findings;
        }

        // 到这里，认为是 EIP-1967 代理，核心检查：Beacon 槽是否已初始化
        if (!beaconZero) {
            findings.push({
                id: 'mixing-patterns-eip1967-beacon-initialized',
                title: 'EIP-1967 beacon slot is non-zero; Teller-style uninitialized beacon pattern not present',
                severity: 'info',
                metadata: {
                    proxyAddress: ctx.proxy.address,
                    logicAddress: ctx.logic.address,
                    beaconSlot: beaconWord,
                    implementationSlot: implWord,
                    adminSlot: adminWord,
                    notes:
                        'Beacon slot already initialized on-chain. A Teller-style “uninitialized beacon” attack is not possible under the standard EIP-1967 pattern.',
                } as any,
            });
            return findings;
        }

        // Beacon 槽为 0：这是 Teller 模式的核心危险信号。
        // 在此基础上，再用字节码扫描初始化函数的权限模式。
        const beaconInit = analyzeBeaconInitializerFromBytecode(proxyBytecode, EIP1967_BEACON_SLOT);

        let severity: PairDetectorFinding['severity'] = 'high';
        let id = 'mixing-patterns-eip1967-beacon-zero';
        let description =
            'Beacon slot in the standard EIP-1967 location is zero on-chain. This matches the first step of the Teller-style attack. ' +
            'No explicit initializer writing this slot was identified in bytecode; manual review is still recommended.';

        if (beaconInit.hasWrite && beaconInit.hasUnprotected) {
            // 找到写入 beacon 槽但没有明显 CALLER 访问控制的初始化函数：最高风险
            severity = 'critical';
            id = 'mixing-patterns-eip1967-beacon-zero-unprotected-init';
            description =
                'Beacon slot is zero and bytecode contains a write to the EIP-1967 beacon slot without an apparent CALLER-based access control pattern. ' +
                'This strongly resembles a Teller-style uninitialized beacon initializer callable by arbitrary users.';
        } else if (beaconInit.hasWrite && beaconInit.hasProtected && !beaconInit.hasUnprotected) {
            // 只找到带权限检查的初始化：风险下降
            severity = 'medium';
            id = 'mixing-patterns-eip1967-beacon-zero-protected-init';
            description =
                'Beacon slot is zero but bytecode only shows writes to the EIP-1967 beacon slot guarded by a CALLER/EQ/JUMPI-style access control pattern. ' +
                'The proxy appears to rely on a protected initializer; risk is lower but manual confirmation is advised.';
        }

        findings.push({
            id,
            title: 'EIP-1967 beacon slot is zero; proxy appears uninitialized (potential Teller-style pattern)',
            severity,
            metadata: {
                proxyAddress: ctx.proxy.address,
                logicAddress: ctx.logic.address,
                beaconSlot: beaconWord,
                implementationSlot: implWord,
                adminSlot: adminWord,
                beaconBytecodePatterns: beaconInit,
                notes: {
                    description,
                },
            } as any,
        });

        return findings;
    },
};
