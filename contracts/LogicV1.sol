// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// 升级的关键点：保持变量顺序与类型不变（存储布局稳定）
contract LogicV1 {
    uint256 public x;

    event Set(uint256 x);

    function setX(uint256 _x) external {
        x = _x;
        emit Set(_x);
    }

    function version() external pure returns (string memory) {
        return "V1";
    }
}
