// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Local-test example, not an audited production application.
contract NiuGuestbook {
    string public message;
    address public immutable owner;
    uint256 public updates;
    event MessageChanged(address indexed author, string message);

    constructor(string memory firstMessage) {
        owner = msg.sender;
        message = firstMessage;
    }

    function setMessage(string calldata nextMessage) external {
        require(msg.sender == owner, "Only owner");
        message = nextMessage;
        updates++;
        emit MessageChanged(msg.sender, nextMessage);
    }
}
