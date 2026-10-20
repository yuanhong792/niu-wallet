// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Capped, mintable and pausable ERC-20 template used by NIU Wallet.
/// @dev The owner may mint only up to cap(), pause transfers, or transfer ownership.
contract NiuManagedToken is ERC20, ERC20Burnable, ERC20Pausable, Ownable {
    uint8 private immutable _tokenDecimals;
    uint256 public immutable cap;

    error CapExceeded(uint256 requestedSupply, uint256 maximumSupply);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address owner_,
        uint256 initialSupply_,
        uint256 cap_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        require(initialSupply_ > 0, "Zero supply");
        require(cap_ >= initialSupply_, "Cap below supply");
        _tokenDecimals = decimals_;
        cap = cap_;
        _mint(owner_, initialSupply_);
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        uint256 nextSupply = totalSupply() + amount;
        if (nextSupply > cap) revert CapExceeded(nextSupply, cap);
        _mint(to, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Pausable)
    {
        super._update(from, to, value);
    }
}
