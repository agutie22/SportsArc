// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {DeployBase} from "./DeployBase.sol";

/// @title DeployAll
/// @notice The whole SportsArc deploy (deploy/CONTRACTS.md), in order:
///           SportsArcRecord  the public record: one entry per fact, written by the relayer
///           EventVault       paid events: entry fees to the host, host prizes
///
///   forge script script/DeployAll.s.sol --rpc-url arc_testnet \
///     --account <keystore> --broadcast --slow --timeout 300
///
/// Without --broadcast it is a dry run against the RPC's state, which is how
/// to check roles and USDC before sending anything. Pass --sender <address>
/// to dry-run as an account without its key. To deploy one contract and
/// leave the other in place, use DeployRecord.s.sol or DeployEvents.s.sol.
contract DeployAll is DeployBase {
    function run() external returns (Deployed memory) {
        return deployAll(msg.sender, readRoleEnv(), readEventSettings());
    }

    /// Everything run() does, with the deployer, the role env and
    /// EventVault's settings passed in.
    function deployAll(address deployer, RoleEnv memory e, EventSettings memory s)
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
        deployRecordContracts(r, d);
        deployEventContracts(r, s, d);
        vm.stopBroadcast();

        checkDeployed(r, d);
        checkEventSettings(s, d);
        printEnv(chainKey, r, d);
    }
}
