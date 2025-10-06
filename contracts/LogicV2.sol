// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// keep the same variable layout as V1 (here still only x)
contract LogicV2 {
    uint256 public x;

    function setX(uint256 _x) external {
        x = _x;
    }

    function add(uint256 y) external {
        x += y;
    }

    function version() external pure returns (string memory) {
        return "V2";
    }
}
