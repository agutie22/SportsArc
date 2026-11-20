// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeployBase} from "./DeployBase.sol";

/// @title DeployEvents
/// @notice Adds EventVault (paid events: entry fees and sponsor prizes) to a
///         chain that already has the rest. Testnet only, with the same chain
///         guard and role env as DeployRecord, plus EventVault's settings
///         (DEPLOY_FEE_BPS, DEPLOY_GAS_FEE, DEPLOY_CORRECTION_WINDOW; see
///         DeployBase). The relayer (TESTNET_PRIVATE_KEY on the server)
///         signs entry and prize permits and results; the payout router
///         (PAYOUT_PRIVATE_KEY on the server) forwards routed payouts; the
///         treasury receives the platform fee; the owner can replace the
///         signer. That is what api/web3/events and api/web3/gateway expect.
///
///   forge script script/DeployEvents.s.sol --rpc-url arc_testnet \
///     --private-key <key> --broadcast
contract DeployEvents is DeployBase {
    function run() external returns (Deployed memory) {
        return deployEvents(msg.sender, readRoleEnv(), readEventSettings());
    }

    /// Everything run() does, with the deployer, the role env and the
    /// settings passed in.
    function deployEvents(address deployer, RoleEnv memory e, EventSettings memory s)
        public
        returns (Deployed memory d)
    {
        string memory chainKey = chainKeyOf(block.chainid);
        Roles memory r = resolveRoles(block.chainid, deployer, e);
        checkUsdc(r.usdc);
        logRoles(chainKey, r, e);
        requireSeparateKeys(r);

        vm.startBroadcast(r.deployer);
        d.usdc = r.usdc;
        deployEventContracts(r, s, d);
        vm.stopBroadcast();

        checkDeployed(r, d);
        checkEventSettings(s, d);
        printEnv(chainKey, r, d);
    }
}
