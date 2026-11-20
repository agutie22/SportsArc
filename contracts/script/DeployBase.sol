// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {EventVault} from "../src/EventVault.sol";
import {SportsArcRecord} from "../src/SportsArcRecord.sol";

/// @title DeployBase
/// @notice What every SportsArc deploy script shares (runbook: deploy/CONTRACTS.md):
///         the chains it may touch, who holds each role, the checks run before
///         and after deploying, and the env lines the server reads
///         (api/web3/contracts.ts).
///
/// Testnet only: Arc testnet (5042002). Every other chain id is refused
/// before anything is sent.
///
/// Roles come from env as addresses. The deployer's key never passes through
/// here: forge signs with --account or --private-key, and the deployer is the
/// account forge runs the script as.
///   relayer   DEPLOY_RELAYER, else the address of TESTNET_PRIVATE_KEY (the
///             server key chains.ts relayer() signs with), else the deployer.
///             Writes entries to SportsArcRecord and signs EventVault permits
///             and results.
///             Only its address is derived; the key is never logged.
///   payout router  DEPLOY_PAYOUT_ROUTER, else the address of
///             PAYOUT_PRIVATE_KEY (the server's Gateway payout wallet,
///             gateway/payouts.ts), else the relayer. Receives a routed
///             player's money and forwards it to the chain they chose.
///   owner     DEPLOY_OWNER, else the deployer: SportsArcRecord's list of writers,
///             and EventVault's signer (replaced after a day's notice).
///   treasury  DEPLOY_TREASURY, else the deployer: the platform fee on
///             event entries.
///   USDC      DEPLOY_USDC, else the chain's testnet USDC.
/// Every role left to its default is logged as a warning.
///
/// Two keys sit on the server: the relayer and the payout router. They must
/// differ, and neither may be the owner or the treasury (SharedKey). Kept
/// apart:
///   - the key that signs event results is not the one paid the fee;
///   - a leaked server key cannot collect what the treasury is owed;
///   - the key that signs is not the one holding money in transit, so a
///     leaked relayer cannot take a routed payout, nor the payout wallet
///     sign a permit;
///   - the owner can drop a leaked relayer from SportsArcRecord's writers and
///     replace EventVault's signer, without a redeploy.
///
/// EventVault's settings are fixed at deploy and come from env as numbers:
///   DEPLOY_FEE_BPS            the platform's share of an entry fee, in basis
///                             points (default 100, which is 1%; at most 300)
///   DEPLOY_GAS_FEE            the flat part of the fee per entry, in USDC base
///                             units (default 20000, two cents; at most 100000).
///                             Set it from what a relayed entry costs in gas
///                             (deploy/CONTRACTS.md has the measurements).
///   DEPLOY_CORRECTION_WINDOW  seconds a posted result can be corrected
///                             (default 3600; at most 7 days)
abstract contract DeployBase is Script {
    uint256 internal constant ARC_TESTNET = 5_042_002;

    /// Arc's native USDC through its ERC-20 interface (api/circle/chain-config.ts).
    address internal constant ARC_TESTNET_USDC = 0x3600000000000000000000000000000000000000;
    uint8 internal constant USDC_DECIMALS = 6;

    uint16 internal constant DEFAULT_FEE_BPS = 100;
    /// Two cents: a relayed entry costs the platform about 0.6–1.1¢ in gas at
    /// Arc testnet's 25 gwei (deploy/CONTRACTS.md), with room for gas to rise.
    uint256 internal constant DEFAULT_GAS_FEE = 20_000;
    uint64 internal constant DEFAULT_CORRECTION_WINDOW = 1 hours;

    /// Raw role inputs; address(0) means unset.
    struct RoleEnv {
        address relayer; // DEPLOY_RELAYER
        address relayerFromKey; // address of TESTNET_PRIVATE_KEY
        address owner; // DEPLOY_OWNER
        address treasury; // DEPLOY_TREASURY
        address usdc; // DEPLOY_USDC
        address payoutRouter; // DEPLOY_PAYOUT_ROUTER
        address payoutRouterFromKey; // address of PAYOUT_PRIVATE_KEY
    }

    /// Resolved roles; none is ever address(0).
    struct Roles {
        address deployer;
        address relayer;
        address owner;
        address treasury;
        address usdc;
        address payoutRouter;
    }

    /// EventVault's deploy-time settings.
    struct EventSettings {
        uint16 feeBps;
        uint256 gasFee;
        uint64 correctionWindow;
    }

    struct Deployed {
        address usdc;
        SportsArcRecord record;
        EventVault eventVault;
    }

    error UnsupportedChain(uint256 chainId);
    error NoDeployer();
    error RelayerMismatch(address deployRelayer, address testnetKeyAddress);
    error PayoutRouterMismatch(address deployPayoutRouter, address payoutKeyAddress);
    error BadEnvAddress(string name);
    error BadPrivateKey(string name);
    error UsdcNotFound(address usdc);
    error UsdcDecimals(address usdc, uint8 decimals);
    error WiringMismatch(string what);
    error BadEventSetting(string name);
    error SharedKey(string role);

    // ---- chains -------------------------------------------------------------

    /// The WEB3_CHAIN key (api/web3/chains.ts) for a testnet chain id; reverts
    /// for anything else.
    function chainKeyOf(uint256 chainId) public pure returns (string memory) {
        if (chainId == ARC_TESTNET) return "arcTestnet";
        revert UnsupportedChain(chainId);
    }

    /// Arc testnet USDC; reverts for any other chain.
    function defaultUsdc(uint256 chainId) public pure returns (address) {
        if (chainId == ARC_TESTNET) return ARC_TESTNET_USDC;
        revert UnsupportedChain(chainId);
    }

    // ---- roles --------------------------------------------------------------

    function readRoleEnv() public view returns (RoleEnv memory e) {
        e.relayer = _envAddress("DEPLOY_RELAYER");
        e.relayerFromKey = _envKeyAddress("TESTNET_PRIVATE_KEY");
        e.owner = _envAddress("DEPLOY_OWNER");
        e.treasury = _envAddress("DEPLOY_TREASURY");
        e.usdc = _envAddress("DEPLOY_USDC");
        e.payoutRouter = _envAddress("DEPLOY_PAYOUT_ROUTER");
        e.payoutRouterFromKey = _envKeyAddress("PAYOUT_PRIVATE_KEY");
    }

    /// Apply the defaults in the contract header. Refuses a chain off the
    /// list, a missing deployer, and a DEPLOY_RELAYER that is not the
    /// server's key.
    function resolveRoles(uint256 chainId, address deployer, RoleEnv memory e) public pure returns (Roles memory r) {
        address chainUsdc = defaultUsdc(chainId);
        if (deployer == address(0) || deployer == DEFAULT_SENDER) revert NoDeployer();
        if (e.relayer != address(0) && e.relayerFromKey != address(0) && e.relayer != e.relayerFromKey) {
            revert RelayerMismatch(e.relayer, e.relayerFromKey);
        }
        if (e.payoutRouter != address(0) && e.payoutRouterFromKey != address(0) && e.payoutRouter != e.payoutRouterFromKey) {
            revert PayoutRouterMismatch(e.payoutRouter, e.payoutRouterFromKey);
        }
        r.deployer = deployer;
        r.relayer = _or(e.relayer, _or(e.relayerFromKey, deployer));
        r.owner = _or(e.owner, deployer);
        r.treasury = _or(e.treasury, deployer);
        r.usdc = _or(e.usdc, chainUsdc);
        r.payoutRouter = _or(e.payoutRouter, _or(e.payoutRouterFromKey, r.relayer));
    }

    /// The two server keys differ, and the owner and the treasury are on
    /// neither; see the contract header. Both contracts have an owner, so
    /// it is checked whichever is deployed.
    function requireSeparateKeys(Roles memory r) public pure {
        if (r.payoutRouter == r.relayer) revert SharedKey("payout router");
        if (r.owner == r.relayer || r.owner == r.payoutRouter) revert SharedKey("owner");
        if (r.treasury == r.relayer || r.treasury == r.payoutRouter) revert SharedKey("treasury");
    }

    // ---- event settings -----------------------------------------------------

    function defaultEventSettings() public pure returns (EventSettings memory) {
        return EventSettings(DEFAULT_FEE_BPS, DEFAULT_GAS_FEE, DEFAULT_CORRECTION_WINDOW);
    }

    /// The DEPLOY_* numbers in the contract header, with their defaults.
    /// Out-of-range values are refused here, by name, before anything is sent.
    function readEventSettings() public view returns (EventSettings memory s) {
        uint256 feeBps = vm.envOr("DEPLOY_FEE_BPS", uint256(DEFAULT_FEE_BPS));
        uint256 gasFee = vm.envOr("DEPLOY_GAS_FEE", DEFAULT_GAS_FEE);
        uint256 window = vm.envOr("DEPLOY_CORRECTION_WINDOW", uint256(DEFAULT_CORRECTION_WINDOW));
        if (feeBps > 300) revert BadEventSetting("DEPLOY_FEE_BPS");
        if (gasFee > 100_000) revert BadEventSetting("DEPLOY_GAS_FEE");
        if (window == 0 || window > 7 days) revert BadEventSetting("DEPLOY_CORRECTION_WINDOW");
        s = EventSettings(uint16(feeBps), gasFee, uint64(window));
    }

    // ---- USDC ---------------------------------------------------------------

    /// A 6-decimal token with code at `usdc`.
    function checkUsdc(address usdc) public view {
        if (usdc.code.length == 0) revert UsdcNotFound(usdc);
        try IERC20Metadata(usdc).decimals() returns (uint8 d) {
            if (d != USDC_DECIMALS) revert UsdcDecimals(usdc, d);
        } catch {
            revert UsdcNotFound(usdc);
        }
    }

    // ---- deploy and check ---------------------------------------------------

    /// The public record: one entry per fact, written by the relayer. Call
    /// while broadcasting.
    function deployRecordContracts(Roles memory r, Deployed memory d) internal {
        d.record = new SportsArcRecord(r.owner, r.relayer);
    }

    /// Paid events. The relayer signs its permits and results, the payout
    /// router forwards routed payouts, the treasury takes the platform fee
    /// and the owner can replace the signer. Call while broadcasting.
    function deployEventContracts(Roles memory r, EventSettings memory s, Deployed memory d) internal {
        d.eventVault = new EventVault(
            IERC20(d.usdc), r.relayer, r.treasury, r.payoutRouter, s.feeBps, s.gasFee, s.correctionWindow, r.owner
        );
    }

    /// Read every role back from the deployed contracts; a contract left at
    /// address(0) was not part of this run and is skipped.
    function checkDeployed(Roles memory r, Deployed memory d) public view {
        _expect(d.usdc == r.usdc, "usdc");
        if (address(d.record) != address(0)) {
            _expect(d.record.owner() == r.owner, "SportsArcRecord.owner");
            _expect(d.record.isWriter(r.relayer), "SportsArcRecord.isWriter(relayer)");
        }
        if (address(d.eventVault) != address(0)) {
            _expect(address(d.eventVault.usdc()) == d.usdc, "EventVault.usdc");
            _expect(d.eventVault.signer() == r.relayer, "EventVault.signer");
            _expect(d.eventVault.treasury() == r.treasury, "EventVault.treasury");
            _expect(d.eventVault.payoutRouter() == r.payoutRouter, "EventVault.payoutRouter");
            _expect(d.eventVault.owner() == r.owner, "EventVault.owner");
        }
    }

    /// The settings EventVault was deployed with, read back from it.
    function checkEventSettings(EventSettings memory s, Deployed memory d) public view {
        _expect(d.eventVault.FEE_BPS() == s.feeBps, "EventVault.FEE_BPS");
        _expect(d.eventVault.GAS_FEE() == s.gasFee, "EventVault.GAS_FEE");
        _expect(d.eventVault.CORRECTION_WINDOW() == s.correctionWindow, "EventVault.CORRECTION_WINDOW");
    }

    // ---- output -------------------------------------------------------------

    function logRoles(string memory chainKey, Roles memory r, RoleEnv memory e) internal view {
        console2.log("SportsArc deploy, chain", chainKey);
        console2.log("  deployer ", r.deployer);
        console2.log("  relayer  ", r.relayer);
        console2.log("  owner    ", r.owner);
        console2.log("  treasury ", r.treasury);
        console2.log("  payout   ", r.payoutRouter);
        console2.log("  usdc     ", r.usdc);

        if (e.relayer == address(0) && e.relayerFromKey == address(0)) {
            _warn("no DEPLOY_RELAYER or TESTNET_PRIVATE_KEY: the relayer is the deployer");
        }
        if (e.owner == address(0)) _warn("DEPLOY_OWNER unset: the deployer owns both contracts");
        if (e.payoutRouter == address(0) && e.payoutRouterFromKey == address(0)) {
            _warn("no DEPLOY_PAYOUT_ROUTER or PAYOUT_PRIVATE_KEY: the payout router is the relayer");
        }
        if (e.treasury == address(0)) _warn("DEPLOY_TREASURY unset: the deployer is the treasury");
        if (r.deployer == r.relayer) {
            _warn("the deployer is the relayer: DEPLOY_OWNER and DEPLOY_TREASURY must be set");
        }
        address chainUsdc = defaultUsdc(block.chainid);
        if (e.usdc != address(0) && e.usdc != chainUsdc) {
            _warn("DEPLOY_USDC is not this chain's USDC");
        }
    }

    /// Ready-to-paste env lines, names from api/web3/contracts.ts, for the
    /// contracts this run deployed.
    function printEnv(string memory chainKey, Roles memory r, Deployed memory d) internal pure {
        console2.log("");
        console2.log("---- SportsArc env (paste into .env) ----");
        console2.log(string.concat("WEB3_CHAIN=", chainKey));
        _line("WEB3_USDC_ADDRESS", d.usdc);
        if (address(d.record) != address(0)) _line("RECORD_CONTRACT_ADDRESS", address(d.record));
        if (address(d.eventVault) != address(0)) _line("EVENT_VAULT_ADDRESS", address(d.eventVault));
        console2.log("---- end SportsArc env ----");
        console2.log("TESTNET_PRIVATE_KEY on the server must be the key of", r.relayer);
        if (address(d.eventVault) != address(0)) {
            console2.log("PAYOUT_PRIVATE_KEY on the server must be the key of", r.payoutRouter);
        }
    }

    // ---- helpers ------------------------------------------------------------

    function _line(string memory name, address value) private pure {
        console2.log(string.concat(name, "=", vm.toString(value)));
    }

    function _warn(string memory message) internal pure {
        console2.log(string.concat("!! WARNING: ", message));
    }

    function _expect(bool ok, string memory what) internal pure {
        if (!ok) revert WiringMismatch(what);
    }

    function _or(address a, address b) private pure returns (address) {
        return a != address(0) ? a : b;
    }

    function _envAddress(string memory name) internal view returns (address) {
        string memory raw = vm.trim(vm.envOr(name, string("")));
        if (bytes(raw).length == 0) return address(0);
        if (!_isHex(bytes(raw), 20)) revert BadEnvAddress(name);
        return vm.parseAddress(raw);
    }

    /// The address of a private key in env, checked against chains.ts's rule
    /// (0x and 64 hex digits) before parsing, so a malformed key is never
    /// echoed in a parse error.
    function _envKeyAddress(string memory name) internal view returns (address) {
        string memory raw = vm.trim(vm.envOr(name, string("")));
        if (bytes(raw).length == 0) return address(0);
        if (!_isHex(bytes(raw), 32)) revert BadPrivateKey(name);
        uint256 key = vm.parseUint(raw);
        if (key == 0 || key >= SECP256K1_ORDER) revert BadPrivateKey(name);
        return vm.addr(key);
    }

    /// "0x" followed by exactly 2 * size hex digits.
    function _isHex(bytes memory s, uint256 size) private pure returns (bool) {
        if (s.length != 2 + 2 * size || s[0] != "0" || (s[1] != "x" && s[1] != "X")) return false;
        for (uint256 i = 2; i < s.length; i++) {
            bytes1 c = s[i];
            bool digit = c >= "0" && c <= "9";
            bool lower = c >= "a" && c <= "f";
            bool upper = c >= "A" && c <= "F";
            if (!digit && !lower && !upper) return false;
        }
        return true;
    }
}
