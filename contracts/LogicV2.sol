// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// 保持与 V1 相同的前置变量布局（这里仍然只有 x）
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
