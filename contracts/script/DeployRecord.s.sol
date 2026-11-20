// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeployBase} from "./DeployBase.sol";

/// @title DeployRecord
/// @notice Deploys a fresh SportsArcRecord alone, leaving EventVault (and the
///         paid events on it) where it is. Testnet only, with the same chain
///         guard and role env as DeployAll: the relayer (TESTNET_PRIVATE_KEY
///         on the server) is the only writer, and DEPLOY_OWNER owns the list
///         of writers. Entries in an older record contract stay there; the
///         server writes every entry again to the new one
///         (docs/verified-record.md).
///
///   forge script script/DeployRecord.s.sol --rpc-url arc_testnet \
///     --private-key <key> --broadcast
contract DeployRecord is DeployBase {
    function run() external returns (Deployed memory) {
        return deployRecord(msg.sender, readRoleEnv());
    }

    /// Everything run() does, with the deployer and the role env passed in.
    function deployRecord(address deployer, RoleEnv memory e) public returns (Deployed memory d) {
        string memory chainKey = chainKeyOf(block.chainid);
        Roles memory r = resolveRoles(block.chainid, deployer, e);
        checkUsdc(r.usdc);
        logRoles(chainKey, r, e);
        requireSeparateKeys(r);

        vm.startBroadcast(r.deployer);
        d.usdc = r.usdc;
        deployRecordContracts(r, d);
        vm.stopBroadcast();

        checkDeployed(r, d);
        printEnv(chainKey, r, d);
    }
}
