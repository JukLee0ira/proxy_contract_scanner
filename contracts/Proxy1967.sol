// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Minimal EIP-1967 Proxy (demo only)
// 仅用于学习演示：没有访问控制，任何人都能 upgrade，勿用于生产。
contract Proxy1967 {
    // EIP-1967 implementation slot = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
    bytes32 private constant IMPLEMENTATION_SLOT =
        0x360894A13BA1A3210667C828492DB98DCA3E2076CC3735A920A3CA505D382BBC;

    event Upgraded(address indexed newImplementation);

    constructor(address impl_) {
        _setImplementation(impl_);
    }

    function implementation() external view returns (address impl) {
        impl = _getImplementation();
    }

    // ⚠️ 演示用：无权限控制。生产上至少要加 onlyOwner/admin。
    function upgrade(address newImpl) external {
        require(newImpl.code.length > 0, "not a contract");
        _setImplementation(newImpl);
        emit Upgraded(newImpl);
    }

    // --- delegate 逻辑 ---
    fallback() external payable {
        _delegate(_getImplementation());
    }

    receive() external payable {
        _delegate(_getImplementation());
    }

    function _getImplementation() internal view returns (address impl) {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            impl := sload(slot)
        }
    }

    function _setImplementation(address newImpl) internal {
        bytes32 slot = IMPLEMENTATION_SLOT;
        assembly {
            sstore(slot, newImpl)
        }
    }

    function _delegate(address impl) internal {
        assembly {
            // 拷贝 calldata
            calldatacopy(0, 0, calldatasize())
            // delegatecall 到实现合约
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            // 拷贝返回数据
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
