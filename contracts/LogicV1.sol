// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// key points of upgrade: keep variable order and type unchanged (storage layout stable)
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
