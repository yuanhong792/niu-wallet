// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @notice Fixed-supply ERC-20 template used by NIU Wallet.
/// @dev The complete supply is minted once. There is no owner and no mint function.
contract NiuFixedToken is ERC20, ERC20Burnable {
    uint8 private immutable _tokenDecimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address receiver_,
        uint256 initialSupply_
    ) ERC20(name_, symbol_) {
        require(receiver_ != address(0), "Zero receiver");
        require(initialSupply_ > 0, "Zero supply");
        _tokenDecimals = decimals_;
        _mint(receiver_, initialSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }
}
