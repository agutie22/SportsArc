// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Toolchain smoke test. It proves the installed deps resolve through
// remappings.txt:
//
//   forge test --match-path test/Toolchain.t.sol

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract ToolchainTest is Test {
    function test_compilerAndDeps() public pure {
        // A signature made by forge recovers through OZ's ECDSA, as EventVault's permits do.
        uint256 key = 0xA11CE;
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(keccak256("sportsarc"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        assertEq(ECDSA.recover(digest, v, r, s), vm.addr(key));
    }
}
