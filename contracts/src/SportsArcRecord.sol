// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {RecordHash} from "./record/RecordHash.sol";

/// @title SportsArcRecord
/// @notice The public record of SportsArc games. Each entry is one fact (a
///         check-in, a missed game, a result), written once and never
///         changed or removed. To check an entry, rebuild its hash from the
///         facts and call writtenAt(entry): the block time it was written,
///         or 0 if it never was.
/// @dev    Only hashes reach this contract. An entry hash is built in
///         RecordHash from hashed ids and a salted player code, and never
///         contains personal data. The owner manages the list of writers
///         (SportsArc's server key); writers can only add entries.
///         The kind is in the Written event for explorers; it is also inside
///         the hash, so storage holds the time alone.
contract SportsArcRecord is Ownable2Step {
    /// Kind tags, readable from the contract: keccak256 of the kind's name.
    bytes32 public constant CHECKIN = RecordHash.CHECKIN;
    bytes32 public constant NOSHOW = RecordHash.NOSHOW;
    bytes32 public constant GAME = RecordHash.GAME;
    bytes32 public constant RESULT = RecordHash.RESULT;
    bytes32 public constant PRESENCE = RecordHash.PRESENCE;
    bytes32 public constant STANDING = RecordHash.STANDING;
    bytes32 public constant MEMBER = RecordHash.MEMBER;
    bytes32 public constant SEASON = RecordHash.SEASON;

    mapping(address writer => bool allowed) public isWriter;
    mapping(bytes32 entry => uint64 writtenAt) private _writtenAt;

    event WriterSet(address indexed writer, bool allowed);
    event Written(bytes32 indexed entry, bytes32 indexed kind, address indexed writer);

    error NotWriter(address caller);
    error ZeroEntry();
    error ZeroKind();
    error AlreadyWritten(bytes32 entry);

    constructor(address initialOwner, address initialWriter) Ownable(initialOwner) {
        if (initialWriter != address(0)) _setWriter(initialWriter, true);
    }

    // ── writes ──────────────────────────────────────────────────────────

    function setWriter(address writer, bool allowed) external onlyOwner {
        _setWriter(writer, allowed);
    }

    /// @notice Write one entry. Reverts if that entry was ever written.
    function write(bytes32 entry, bytes32 kind) external {
        if (!isWriter[msg.sender]) revert NotWriter(msg.sender);
        if (entry == bytes32(0)) revert ZeroEntry();
        if (kind == bytes32(0)) revert ZeroKind();
        if (_writtenAt[entry] != 0) revert AlreadyWritten(entry);
        _writtenAt[entry] = uint64(block.timestamp);
        emit Written(entry, kind, msg.sender);
    }

    // ── reads ───────────────────────────────────────────────────────────

    /// @notice Block time the entry was written; 0 if it never was.
    function writtenAt(bytes32 entry) public view returns (uint64) {
        return _writtenAt[entry];
    }

    function isWritten(bytes32 entry) external view returns (bool) {
        return _writtenAt[entry] != 0;
    }

    /// @notice writtenAt for a check-in rebuilt from its facts; see RecordHash.checkIn.
    function checkInWrittenAt(bytes32 game, bytes32 player, uint64 checkedInAt) external view returns (uint64) {
        return writtenAt(RecordHash.checkIn(game, player, checkedInAt));
    }

    /// @notice writtenAt for a missed game rebuilt from its facts; see RecordHash.noShow.
    function noShowWrittenAt(bytes32 game, bytes32 player, uint64 closedAt) external view returns (uint64) {
        return writtenAt(RecordHash.noShow(game, player, closedAt));
    }

    function _setWriter(address writer, bool allowed) private {
        isWriter[writer] = allowed;
        emit WriterSet(writer, allowed);
    }
}
