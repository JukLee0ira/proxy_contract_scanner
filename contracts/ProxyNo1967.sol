// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal proxy (NOT EIP-1967). No events when upgrading. No access control.
/// Use for demo only.
contract ProxyNo1967 {
    // self-defined slot: keccak256("simple.proxy.impl")
    bytes32 private constant IMPL_SLOT = keccak256("simple.proxy.impl");

    constructor(address _impl) {
        require(_impl.code.length > 0, "impl not contract");
        _setImplementation(_impl);
    }

    function implementation() public view returns (address impl) {
        impl = _getImplementation();
    }

    // for demo only: anyone can call upgrade (no events)
    function upgrade(address newImpl) external {
        require(newImpl.code.length > 0, "impl not contract");
        _setImplementation(newImpl);
        // note: **no** emit Event
    }

    // fallback / receive delegate to implementation
    fallback() external payable {
        _delegate(_getImplementation());
    }

    receive() external payable {
        _delegate(_getImplementation());
    }

    function _getImplementation() internal view returns (address impl) {
        bytes32 slot = IMPL_SLOT;
        assembly {
            impl := sload(slot)
        }
    }

    function _setImplementation(address newImpl) internal {
        bytes32 slot = IMPL_SLOT;
        assembly {
            sstore(slot, newImpl)
        }
    }

    function _delegate(address impl) internal {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
