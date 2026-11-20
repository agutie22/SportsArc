// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Tests of the deploy scripts (deploy/CONTRACTS.md): the chain guard, role
// resolution, the USDC checks, the env reader, and that what DeployAll
// deploys is wired for the server: the relayer writes record entries and signs
// event permits and results, and the payout router is a key of its own. Runs as
// Arc testnet (chain id only, no network) with a test token at its USDC
// address.

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {DeployBase} from "../script/DeployBase.sol";
import {DeployAll} from "../script/DeployAll.s.sol";
import {DeployEvents} from "../script/DeployEvents.s.sol";
import {DeployRecord} from "../script/DeployRecord.s.sol";
import {EventVault} from "../src/EventVault.sol";
import {SportsArcRecord} from "../src/SportsArcRecord.sol";
import {RecordHash} from "../src/record/RecordHash.sol";
import {TestUSDC} from "./TestUSDC.sol";

/// An ERC-20 with OpenZeppelin's default 18 decimals.
contract Token18 is ERC20 {
    constructor() ERC20("Eighteen", "E18") {}
}

/// Code with no decimals().
contract NoDecimals {
    function hello() external pure returns (uint256) {
        return 1;
    }
}

contract DeployTest is Test {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    uint256 internal constant ARC = 5_042_002;

    DeployAll internal script;
    /// EventVault's default settings, read once so a test can expect a revert on the very next call.
    DeployBase.EventSettings internal settings;
    address internal deployer = makeAddr("deployer");
    uint256 internal relayerKey = 0x5EC7E7;
    address internal relayer;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    uint256 internal payoutKey = 0x9A70E7;
    address internal payout;

    function setUp() public {
        script = new DeployAll();
        settings = script.defaultEventSettings();
        relayer = vm.addr(relayerKey);
        payout = vm.addr(payoutKey);
        vm.chainId(ARC);
        vm.etch(ARC_USDC, address(new TestUSDC()).code);
    }

    function _env() internal view returns (DeployBase.RoleEnv memory e) {
        e.relayerFromKey = relayer;
        e.owner = owner;
        e.treasury = treasury;
        e.payoutRouterFromKey = payout;
    }

    function _deploy() internal returns (DeployBase.Deployed memory) {
        return script.deployAll(deployer, _env(), settings);
    }

    // ---- what gets deployed ---------------------------------------------------

    function test_deployRecordAloneLeavesEventVaultOut() public {
        DeployBase.Deployed memory d = new DeployRecord().deployRecord(deployer, _env());

        assertEq(vm.getNonce(deployer), 1, "one CREATE: SportsArcRecord only");
        assertEq(address(d.record), vm.computeCreateAddress(deployer, 0));
        assertEq(address(d.eventVault), address(0));
        assertEq(d.record.owner(), owner);
        assertTrue(d.record.isWriter(relayer));
        assertFalse(d.record.isWriter(deployer));
    }

    function test_deployRecordRefusesAnOwnerOnTheRelayer() public {
        DeployBase.RoleEnv memory e = _env();
        e.owner = relayer;
        DeployRecord recordScript = new DeployRecord();
        vm.expectRevert(abi.encodeWithSelector(DeployBase.SharedKey.selector, "owner"));
        recordScript.deployRecord(deployer, e);
    }

    function test_deploysInOrderAndWiresEveryRole() public {
        DeployBase.Deployed memory d = _deploy();

        // Two plain CREATEs from the deployer, in the documented order.
        assertEq(vm.getNonce(deployer), 2);
        assertEq(address(d.record), vm.computeCreateAddress(deployer, 0));
        assertEq(address(d.eventVault), vm.computeCreateAddress(deployer, 1));

        assertEq(d.usdc, ARC_USDC, "the chain's USDC; no token is deployed");
        assertEq(IERC20Metadata(d.usdc).decimals(), 6);

        assertEq(d.record.owner(), owner);
        assertTrue(d.record.isWriter(relayer));
        assertFalse(d.record.isWriter(deployer));

        assertEq(address(d.eventVault.usdc()), d.usdc);
        assertEq(d.eventVault.signer(), relayer);
        assertEq(d.eventVault.treasury(), treasury);
        assertEq(d.eventVault.payoutRouter(), payout, "its own key, not the relayer");
        assertEq(d.eventVault.owner(), owner);
        assertEq(d.eventVault.FEE_BPS(), 100, "1%");
        assertEq(d.eventVault.GAS_FEE(), 20_000, "two cents");
        assertEq(d.eventVault.CORRECTION_WINDOW(), 1 hours);
    }

    function test_eventsScript_addsOnlyTheVault_withTheGivenSettings() public {
        DeployEvents events = new DeployEvents();
        DeployBase.EventSettings memory s = DeployBase.EventSettings(250, 20_000, 2 minutes);
        DeployBase.Deployed memory d = events.deployEvents(deployer, _env(), s);
        assertEq(vm.getNonce(deployer), 1, "EventVault");
        assertEq(address(d.record), address(0));
        assertEq(d.eventVault.signer(), relayer);
        assertEq(d.eventVault.treasury(), treasury);
        assertEq(d.eventVault.FEE_BPS(), 250);
        assertEq(d.eventVault.GAS_FEE(), 20_000);
        assertEq(d.eventVault.CORRECTION_WINDOW(), 2 minutes);

        // The contract's own caps hold whatever the script is given.
        s.feeBps = 301;
        vm.expectRevert(EventVault.FeeTooHigh.selector);
        events.deployEvents(deployer, _env(), s);
    }

    function test_eventSettings_readFromEnvWithDefaults() public {
        DeployBase.EventSettings memory s = script.readEventSettings();
        assertEq(s.feeBps, 100);
        assertEq(s.gasFee, 20_000);
        assertEq(s.correctionWindow, 1 hours);

        vm.setEnv("DEPLOY_FEE_BPS", "150");
        vm.setEnv("DEPLOY_GAS_FEE", "5000");
        vm.setEnv("DEPLOY_CORRECTION_WINDOW", "120");
        s = script.readEventSettings();
        assertEq(s.feeBps, 150);
        assertEq(s.gasFee, 5000);
        assertEq(s.correctionWindow, 120);

        vm.setEnv("DEPLOY_FEE_BPS", "301");
        vm.expectRevert(abi.encodeWithSelector(DeployBase.BadEventSetting.selector, "DEPLOY_FEE_BPS"));
        script.readEventSettings();
        vm.setEnv("DEPLOY_FEE_BPS", "100");
        vm.setEnv("DEPLOY_GAS_FEE", "100001");
        vm.expectRevert(abi.encodeWithSelector(DeployBase.BadEventSetting.selector, "DEPLOY_GAS_FEE"));
        script.readEventSettings();
        vm.setEnv("DEPLOY_GAS_FEE", "20000");
        vm.setEnv("DEPLOY_CORRECTION_WINDOW", "0");
        vm.expectRevert(abi.encodeWithSelector(DeployBase.BadEventSetting.selector, "DEPLOY_CORRECTION_WINDOW"));
        script.readEventSettings();
        vm.setEnv("DEPLOY_CORRECTION_WINDOW", "3600");
    }

    function test_usdcOverride() public {
        address mine = address(new TestUSDC());
        DeployBase.RoleEnv memory e = _env();
        e.usdc = mine;
        DeployBase.Deployed memory d = script.deployAll(deployer, e, settings);
        assertEq(d.usdc, mine);
        assertEq(address(d.eventVault.usdc()), mine);
        assertEq(vm.getNonce(deployer), 2);
    }

    // ---- refusals -----------------------------------------------------------

    function test_refusesChainsOffTheList(uint64 chainId) public {
        vm.assume(chainId != 5_042_002);
        vm.chainId(chainId);
        vm.expectRevert(abi.encodeWithSelector(DeployBase.UnsupportedChain.selector, uint256(chainId)));
        script.deployAll(deployer, _env(), settings);
    }

    /// Mainnets, HyperEVM (998 and 999), and a local chain: only Arc deploys.
    function test_refusesMainnetsAndLocalChains() public {
        uint64[8] memory refused = [uint64(1), 998, 999, 8453, 42_161, 10, 137, 31_337];
        for (uint256 i; i < refused.length; i++) {
            vm.chainId(refused[i]);
            vm.expectRevert(abi.encodeWithSelector(DeployBase.UnsupportedChain.selector, uint256(refused[i])));
            script.deployAll(deployer, _env(), settings);
        }
        assertEq(vm.getNonce(deployer), 0, "nothing was sent");
    }

    function test_testnetWithoutUsdc_refuses() public {
        vm.etch(ARC_USDC, "");
        vm.expectRevert(abi.encodeWithSelector(DeployBase.UsdcNotFound.selector, ARC_USDC));
        _deploy();
    }

    function test_refusesUsdcWithWrongDecimals() public {
        vm.etch(ARC_USDC, address(new Token18()).code);
        vm.expectRevert(abi.encodeWithSelector(DeployBase.UsdcDecimals.selector, ARC_USDC, uint8(18)));
        _deploy();
    }

    function test_refusesUsdcWithoutDecimals() public {
        vm.chainId(5_042_002);
        vm.etch(ARC_USDC, address(new NoDecimals()).code);
        vm.expectRevert(abi.encodeWithSelector(DeployBase.UsdcNotFound.selector, ARC_USDC));
        _deploy();
    }

    function test_refusesWithoutADeployer() public {
        // DEFAULT_SENDER is who forge runs a script as when given no key.
        address defaultSender = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;
        vm.expectRevert(DeployBase.NoDeployer.selector);
        script.deployAll(defaultSender, _env(), settings);
        vm.expectRevert(DeployBase.NoDeployer.selector);
        script.deployAll(address(0), _env(), settings);
    }

    // ---- roles --------------------------------------------------------------

    function test_rolesDefaultToTheDeployer() public view {
        DeployBase.RoleEnv memory e;
        DeployBase.Roles memory r = script.resolveRoles(ARC, deployer, e);
        assertEq(r.deployer, deployer);
        assertEq(r.relayer, deployer);
        assertEq(r.owner, deployer);
        assertEq(r.treasury, deployer);
        assertEq(r.usdc, ARC_USDC);
        assertEq(r.payoutRouter, deployer, "the relayer, which is the deployer here");
    }

    /// The owner and treasury are kept off the server's key.
    function test_refusesOwnerOrTreasuryOnTheServerKey() public {
        DeployBase.RoleEnv memory e = _env();
        e.treasury = relayer;
        vm.expectRevert(abi.encodeWithSelector(DeployBase.SharedKey.selector, "treasury"));
        script.deployAll(deployer, e, settings);

        e = _env();
        e.owner = relayer;
        vm.expectRevert(abi.encodeWithSelector(DeployBase.SharedKey.selector, "owner"));
        script.deployAll(deployer, e, settings);

        // Deploying with the server's key and leaving the roles to default
        // puts every role on that key: refused.
        e = DeployBase.RoleEnv(address(0), relayer, address(0), address(0), address(0), payout, address(0));
        vm.expectRevert(abi.encodeWithSelector(DeployBase.SharedKey.selector, "owner"));
        script.deployAll(relayer, e, settings);

        // The vault has an owner too, so it is checked there as well.
        DeployEvents events = new DeployEvents();
        e = _env();
        e.owner = relayer;
        vm.expectRevert(abi.encodeWithSelector(DeployBase.SharedKey.selector, "owner"));
        events.deployEvents(deployer, e, settings);
        e = _env();
        e.treasury = relayer;
        vm.expectRevert(abi.encodeWithSelector(DeployBase.SharedKey.selector, "treasury"));
        events.deployEvents(deployer, e, settings);
    }

    /// The payout wallet is the server's second key: not the relayer, and
    /// never the owner or the treasury.
    function test_refusesAPayoutRouterSharingAKey() public {
        DeployEvents events = new DeployEvents();
        DeployBase.RoleEnv memory e = _env();
        e.payoutRouterFromKey = address(0);
        vm.expectRevert(abi.encodeWithSelector(DeployBase.SharedKey.selector, "payout router"));
        events.deployEvents(deployer, e, settings);

        e = _env();
        e.payoutRouterFromKey = relayer;
        vm.expectRevert(abi.encodeWithSelector(DeployBase.SharedKey.selector, "payout router"));
        script.deployAll(deployer, e, settings);

        e = _env();
        e.owner = payout;
        vm.expectRevert(abi.encodeWithSelector(DeployBase.SharedKey.selector, "owner"));
        script.deployAll(deployer, e, settings);

        e = _env();
        e.treasury = payout;
        vm.expectRevert(abi.encodeWithSelector(DeployBase.SharedKey.selector, "treasury"));
        script.deployAll(deployer, e, settings);
        assertEq(vm.getNonce(deployer), 0, "nothing was sent");
    }

    function test_payoutRouterMustMatchThePayoutKey() public {
        DeployBase.RoleEnv memory e;
        e.payoutRouter = owner;
        e.payoutRouterFromKey = payout;
        vm.expectRevert(abi.encodeWithSelector(DeployBase.PayoutRouterMismatch.selector, owner, payout));
        script.resolveRoles(ARC, deployer, e);

        e.payoutRouter = payout;
        assertEq(script.resolveRoles(ARC, deployer, e).payoutRouter, payout);
    }

    /// The deployer may be the server key when the other roles are elsewhere.
    function test_serverKeyMayDeployWithSeparateRoles() public {
        DeployBase.Deployed memory d = script.deployAll(relayer, _env(), settings);
        assertEq(d.record.owner(), owner);
        assertEq(d.eventVault.treasury(), treasury);
    }

    function test_relayerMustMatchTheServerKey() public {
        DeployBase.RoleEnv memory e;
        e.relayer = owner;
        e.relayerFromKey = relayer;
        vm.expectRevert(abi.encodeWithSelector(DeployBase.RelayerMismatch.selector, owner, relayer));
        script.resolveRoles(ARC, deployer, e);

        e.relayer = relayer;
        assertEq(script.resolveRoles(ARC, deployer, e).relayer, relayer);
    }

    /// Precedence: DEPLOY_* first, then the server key for the relayer, then
    /// the deployer. No role is ever zero.
    function testFuzz_roleResolution(address dep, address rel, address fromKey, address own, address tre, address pay)
        public
        view
    {
        vm.assume(dep != address(0) && dep != 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38);
        vm.assume(rel == address(0) || fromKey == address(0) || rel == fromKey);
        DeployBase.RoleEnv memory e = DeployBase.RoleEnv(rel, fromKey, own, tre, address(0), address(0), pay);
        DeployBase.Roles memory r = script.resolveRoles(ARC, dep, e);

        assertEq(r.relayer, rel != address(0) ? rel : fromKey != address(0) ? fromKey : dep);
        assertEq(r.owner, own != address(0) ? own : dep);
        assertEq(r.treasury, tre != address(0) ? tre : dep);
        assertEq(r.payoutRouter, pay != address(0) ? pay : r.relayer);
        assertTrue(r.relayer != address(0) && r.owner != address(0) && r.treasury != address(0) && r.payoutRouter != address(0));
    }

    // ---- post-deploy checks -------------------------------------------------

    function test_checkDeployed_catchesMiswiring() public {
        DeployBase.Deployed memory d = _deploy();
        DeployBase.Roles memory r = script.resolveRoles(ARC, deployer, _env());
        script.checkDeployed(r, d);

        r.relayer = owner;
        vm.expectRevert(abi.encodeWithSelector(DeployBase.WiringMismatch.selector, "SportsArcRecord.isWriter(relayer)"));
        script.checkDeployed(r, d);
    }

    // ---- the free path on the deployed contracts ----------------------------

    function test_freePath_relayerRecordsAGameWithNoUserTransaction() public {
        DeployBase.Deployed memory d = _deploy();
        bytes32 game = keccak256(bytes("3f1c1d0e-4b7a-4c55-9a39-2f4f1b8e6d10"));
        uint64 checkedInAt = uint64(block.timestamp);

        // Two check-ins, salted: no user id or name reaches the chain. Each is its own entry.
        bytes32 p1 = RecordHash.playerCode(keccak256("user one"), keccak256("salt one"));
        bytes32 p2 = RecordHash.playerCode(keccak256("user two"), keccak256("salt two"));
        bytes32 r1 = RecordHash.checkIn(game, p1, checkedInAt);
        bytes32 r2 = RecordHash.checkIn(game, p2, checkedInAt);

        vm.prank(deployer);
        vm.expectRevert(abi.encodeWithSelector(SportsArcRecord.NotWriter.selector, deployer));
        d.record.write(r1, RecordHash.CHECKIN);

        vm.startPrank(relayer);
        d.record.write(r1, RecordHash.CHECKIN);
        d.record.write(r2, RecordHash.CHECKIN);
        vm.stopPrank();
        assertEq(d.record.checkInWrittenAt(game, p1, checkedInAt), block.timestamp);
        assertEq(d.record.checkInWrittenAt(game, p2, checkedInAt), block.timestamp);
        assertEq(d.record.checkInWrittenAt(game, p1, checkedInAt + 1), 0);
    }

    // ---- the env reader (the only test that touches env) --------------------

    function test_run_readsRolesFromEnv() public {
        _setEnv("", _hex32(relayerKey), string.concat("  ", vm.toString(owner), " "));
        vm.setEnv("DEPLOY_TREASURY", vm.toString(treasury));
        vm.setEnv("DEPLOY_USDC", "");
        vm.setEnv("DEPLOY_PAYOUT_ROUTER", "");
        vm.setEnv("PAYOUT_PRIVATE_KEY", _hex32(payoutKey));

        DeployBase.RoleEnv memory e = script.readRoleEnv();
        assertEq(e.relayer, address(0));
        assertEq(e.relayerFromKey, relayer, "the relayer is the server key's address");
        assertEq(e.owner, owner, "whitespace is trimmed");
        assertEq(e.treasury, treasury);
        assertEq(e.payoutRouterFromKey, payout, "the payout router is the payout key's address");

        // run() deploys as whoever forge runs it as: here, this test.
        DeployBase.Deployed memory d = script.run();
        assertEq(d.eventVault.signer(), relayer);
        assertEq(d.record.owner(), owner);
        assertEq(d.eventVault.payoutRouter(), payout);

        // Malformed values are refused by name, and a key is never echoed.
        _setEnv("", "0x1234", vm.toString(owner));
        vm.expectRevert(abi.encodeWithSelector(DeployBase.BadPrivateKey.selector, "TESTNET_PRIVATE_KEY"));
        script.readRoleEnv();
        _setEnv("", _hex32(0), vm.toString(owner));
        vm.expectRevert(abi.encodeWithSelector(DeployBase.BadPrivateKey.selector, "TESTNET_PRIVATE_KEY"));
        script.readRoleEnv();
        _setEnv("", _hex32(relayerKey), "0xnot-an-address");
        vm.expectRevert(abi.encodeWithSelector(DeployBase.BadEnvAddress.selector, "DEPLOY_OWNER"));
        script.readRoleEnv();

        _setEnv("", _hex32(relayerKey), vm.toString(owner));
        vm.setEnv("PAYOUT_PRIVATE_KEY", "0x1234");
        vm.expectRevert(abi.encodeWithSelector(DeployBase.BadPrivateKey.selector, "PAYOUT_PRIVATE_KEY"));
        script.readRoleEnv();

        _setEnv("", "", "");
        vm.setEnv("DEPLOY_TREASURY", "");
        vm.setEnv("PAYOUT_PRIVATE_KEY", "");
    }

    // ---- helpers ------------------------------------------------------------

    function _setEnv(string memory rel, string memory key, string memory own) internal {
        vm.setEnv("DEPLOY_RELAYER", rel);
        vm.setEnv("TESTNET_PRIVATE_KEY", key);
        vm.setEnv("DEPLOY_OWNER", own);
    }

    function _hex32(uint256 v) internal pure returns (string memory) {
        return vm.toString(bytes32(v));
    }


}
