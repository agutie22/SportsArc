// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// EventVault tests. Offline: `forge test --match-path test/EventVault.t.sol`.
// Everyone here signs and nobody but the relayer sends: each call is made by
// `relayer`, an address with no role, the way the platform submits them.
// test_vector_* pins the contract's EIP-712 hashing to the values
// api/web3/events/check.ts computes from api/web3/events/protocol.ts.

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EventVault} from "../src/EventVault.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {BlockingUSDC, TestUSDC} from "./TestUSDC.sol";

contract EventVaultTest is Test {
    uint16 internal constant FEE_BPS = 100; // 1%
    uint256 internal constant GAS_FEE = 20_000; // 2 cents
    uint64 internal constant WINDOW = 1 hours;
    uint256 internal constant USD = 1e6;
    uint256 internal constant FUNDS = 10_000e6;
    bytes32 internal constant EVENT = keccak256("22222222-2222-4222-8222-222222222222");

    BlockingUSDC internal usdc;
    EventVault internal vault;

    uint256 internal serverKey = 0x5E87E8;
    uint256 internal constant ORGANIZER_INDEX = 900;
    uint256 internal organizerKey = 0x1000 + ORGANIZER_INDEX;
    uint256 internal sponsorKey = 0x5B05;
    address internal server;
    address internal organizer;
    address internal sponsor;
    address internal treasury = makeAddr("treasury");
    address internal router = makeAddr("payoutRouter");
    address internal relayer = makeAddr("relayer");
    address internal owner = makeAddr("owner");

    /// Players are keys 0x1000 + i.
    uint256 internal constant PLAYER_KEY = 0x1000;

    uint64 internal closesAt;
    uint64 internal startsAt;
    uint64 internal deadline;

    function setUp() public {
        vm.warp(1_790_000_000);
        server = vm.addr(serverKey);
        organizer = vm.addr(organizerKey);
        sponsor = vm.addr(sponsorKey);
        usdc = new BlockingUSDC();
        vault = _deploy(FEE_BPS, GAS_FEE, WINDOW);
        usdc.mint(sponsor, FUNDS);
        closesAt = uint64(block.timestamp + 2 days);
        startsAt = uint64(block.timestamp + 2 days + 1 hours);
        deadline = uint64(block.timestamp + 5 days);
        vm.startPrank(relayer);
    }

    // ── helpers ─────────────────────────────────────────────────────────

    /// The revert the next helper's final call must hit. The helpers below
    /// read from the vault before they call it, so vm.expectRevert has to be
    /// set at the last moment (_arm), not before the helper.
    bytes internal expectedRevert;

    function _expect(bytes4 selector) internal {
        expectedRevert = abi.encodeWithSelector(selector);
    }

    function _arm() internal {
        if (expectedRevert.length == 0) return;
        vm.expectRevert(expectedRevert);
        delete expectedRevert;
    }

    function _deploy(uint16 feeBps, uint256 gasFee, uint64 window) internal returns (EventVault) {
        return new EventVault(IERC20(address(usdc)), server, treasury, router, feeBps, gasFee, window, owner);
    }

    function _key(uint256 i) internal pure returns (uint256) {
        return PLAYER_KEY + i;
    }

    function _player(uint256 i) internal pure returns (address) {
        return vm.addr(_key(i));
    }

    /// A solo player's team: themselves.
    function _solo(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode(_player(i)));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    /// The USDC receiveWithAuthorization signature for `value` into the vault.
    function _authorize(uint256 key, uint256 value, bytes32 nonce, uint256 validBefore)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                usdc.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), vm.addr(key), address(vault), value, 0, validBefore, nonce
                    )
                )
            )
        );
        return _sign(key, digest);
    }

    function _terms(bytes32 eventId, uint256 fee, uint32 minEntrants, uint32 minAttendees)
        internal
        view
        returns (EventVault.EventTerms memory)
    {
        return EventVault.EventTerms({
            eventId: eventId,
            organizer: organizer,
            entryFee: fee,
            minEntrants: minEntrants,
            minAttendees: minAttendees,
            startsAt: startsAt,
            registrationClosesAt: closesAt,
            resultDeadline: deadline
        });
    }

    function _create(bytes32 eventId, uint256 fee, uint32 minEntrants, uint32 minAttendees) internal {
        EventVault.EventTerms memory t = _terms(eventId, fee, minEntrants, minAttendees);
        vault.createEvent(t, _sign(organizerKey, vault.hashEventTerms(t)));
    }

    function _create(uint256 fee, uint32 minEntrants, uint32 minAttendees) internal {
        _create(EVENT, fee, minEntrants, minAttendees);
    }

    function _entry(bytes32 eventId, uint256 i, bytes32 teamKey, bool routed)
        internal
        view
        returns (EventVault.Entry memory)
    {
        (,,, uint32 attempt,) = vault.seats(eventId, _player(i));
        return EventVault.Entry({eventId: eventId, player: _player(i), teamKey: teamKey, routed: routed, attempt: attempt});
    }

    /// Register player i: fund them with the fee, have them and the server sign.
    function _enter(bytes32 eventId, uint256 i, bytes32 teamKey, bool routed) internal {
        EventVault.Entry memory entry = _entry(eventId, i, teamKey, routed);
        uint256 fee = vault.eventOf(eventId).entryFee;
        bytes32 digest = vault.hashEntry(entry);
        bytes memory playerSig;
        if (fee == 0) {
            playerSig = _sign(_key(i), digest);
        } else {
            usdc.mint(entry.player, fee);
            playerSig = _authorize(_key(i), fee, digest, block.timestamp + 1 hours);
        }
        bytes memory permit = _sign(serverKey, vault.hashEntryPermit(entry));
        _arm();
        vault.register(entry, permit, playerSig, 0, block.timestamp + 1 hours);
    }

    function _enter(uint256 i) internal {
        _enter(EVENT, i, _solo(i), false);
    }

    function _enterMany(uint256 n) internal {
        for (uint256 i; i < n; i++) {
            _enter(i);
        }
    }

    function _leave(uint256 i) internal {
        (,,, uint32 attempt,) = vault.seats(EVENT, _player(i));
        bytes memory sig = _sign(_key(i), vault.hashLeave(EVENT, _player(i), attempt));
        _arm();
        vault.leave(EVENT, _player(i), sig);
    }

    function _split(uint16 a, uint16 b, uint16 c) internal pure returns (uint16[] memory s) {
        uint256 n = c != 0 ? 3 : b != 0 ? 2 : 1;
        s = new uint16[](n);
        s[0] = a;
        if (n > 1) s[1] = b;
        if (n > 2) s[2] = c;
    }

    function _fundAs(uint256 key, uint256 amount, uint16[] memory split, bytes32 salt) internal {
        EventVault.Prize memory p =
            EventVault.Prize({eventId: EVENT, sponsor: vm.addr(key), amount: amount, split: split, salt: salt});
        bytes memory permit = _sign(serverKey, vault.hashPrizePermit(p));
        bytes memory pay = _authorize(key, amount, vault.hashPrize(p), block.timestamp + 1 hours);
        _arm();
        vault.fundPrize(p, permit, pay, 0, block.timestamp + 1 hours);
    }

    function _fund(uint256 amount, uint16[] memory split) internal {
        _fundAs(sponsorKey, amount, split, bytes32(uint256(1)));
    }

    function _teams(bytes32 a) internal pure returns (bytes32[] memory t) {
        t = new bytes32[](1);
        t[0] = a;
    }

    function _teams(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory t) {
        t = new bytes32[](2);
        t[0] = a;
        t[1] = b;
    }

    function _teams(bytes32 a, bytes32 b, bytes32 c) internal pure returns (bytes32[] memory t) {
        t = new bytes32[](3);
        t[0] = a;
        t[1] = b;
        t[2] = c;
    }

    function _none() internal pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    function _post(bytes32[] memory placed, uint32 attendees) internal {
        bytes32 digest = vault.hashResult(EVENT, placed, attendees, vault.eventOf(EVENT).revision);
        _arm();
        vault.postResult(EVENT, placed, attendees, _sign(serverKey, digest), _sign(organizerKey, digest));
    }

    function _status() internal view returns (EventVault.Status) {
        return vault.status(EVENT);
    }

    function _assertStatus(EventVault.Status expected) internal view {
        assertEq(uint8(_status()), uint8(expected));
    }

    // ── deploy ──────────────────────────────────────────────────────────

    function test_deploy_capsTheFeeAndTheWindow() public {
        assertEq(vault.MAX_FEE_BPS(), 300);
        assertEq(vault.MAX_GAS_FEE(), 100_000);
        _deploy(300, 100_000, 7 days);

        vm.expectRevert(EventVault.FeeTooHigh.selector);
        _deploy(301, GAS_FEE, WINDOW);
        vm.expectRevert(EventVault.FeeTooHigh.selector);
        _deploy(FEE_BPS, 100_001, WINDOW);
        vm.expectRevert(EventVault.BadWindow.selector);
        _deploy(FEE_BPS, GAS_FEE, 0);
        vm.expectRevert(EventVault.BadWindow.selector);
        _deploy(FEE_BPS, GAS_FEE, 7 days + 1);

        vm.expectRevert(EventVault.ZeroAddress.selector);
        new EventVault(IERC20(address(0)), server, treasury, router, FEE_BPS, GAS_FEE, WINDOW, owner);
        vm.expectRevert(EventVault.ZeroAddress.selector);
        new EventVault(IERC20(address(usdc)), address(0), treasury, router, FEE_BPS, GAS_FEE, WINDOW, owner);
        vm.expectRevert(EventVault.ZeroAddress.selector);
        new EventVault(IERC20(address(usdc)), server, address(0), router, FEE_BPS, GAS_FEE, WINDOW, owner);
    }

    function test_deploy_needsAnOwner() public {
        assertEq(vault.owner(), owner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new EventVault(IERC20(address(usdc)), server, treasury, router, FEE_BPS, GAS_FEE, WINDOW, address(0));
    }

    // ── replacing the signer ────────────────────────────────────────────

    function test_signer_onlyTheOwnerProposesOrCancels() public {
        address next = vm.addr(0x5E87E9);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer));
        vault.proposeSigner(next);
        vm.stopPrank();
        vm.prank(server);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, server));
        vault.proposeSigner(next);
        vm.prank(owner);
        vm.expectRevert(EventVault.ZeroAddress.selector);
        vault.proposeSigner(address(0));
        vm.prank(owner);
        vault.proposeSigner(next);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer));
        vault.cancelSignerChange();
        vm.prank(owner);
        vault.cancelSignerChange();
        assertEq(vault.pendingSigner(), address(0));
        vm.expectRevert(EventVault.NoSignerChange.selector);
        vault.applySignerChange();
    }

    function test_signer_appliesOnlyAfterTheDelay_byAnyone() public {
        uint256 nextKey = 0x5E87E9;
        address next = vm.addr(nextKey);
        vm.stopPrank();
        vm.prank(owner);
        vm.expectEmit(address(vault));
        emit EventVault.SignerProposed(next, uint64(block.timestamp + 1 days));
        vault.proposeSigner(next);
        assertEq(vault.signer(), server, "nothing changes on a proposal");

        vm.warp(block.timestamp + 1 days - 1);
        vm.expectRevert(EventVault.SignerChangeNotReady.selector);
        vault.applySignerChange();
        vm.warp(block.timestamp + 1);
        vm.prank(relayer);
        vault.applySignerChange();
        assertEq(vault.signer(), next);
        assertEq(vault.pendingSigner(), address(0));
        assertEq(vault.signerChangeAt(), 0);
    }

    function test_signer_aNewSignerIsTheOnlyOneHonoured() public {
        // An event opened under the old key keeps running under the new one.
        _create(10 * USD, 1, 1);
        _enter(0);
        uint256 oldKey = serverKey;
        uint256 nextKey = 0x5E87E9;
        vm.stopPrank();
        vm.prank(owner);
        vault.proposeSigner(vm.addr(nextKey));
        vm.warp(block.timestamp + 1 days);
        vault.applySignerChange();
        vm.startPrank(relayer);

        // The old key's permit is refused; the new key's is taken.
        _expect(EventVault.BadSignature.selector);
        _enter(1);
        serverKey = nextKey;
        _enter(1);
        assertEq(vault.eventOf(EVENT).entrants, 2);
        assertTrue(oldKey != serverKey);
    }

    function test_owner_handsOverInTwoSteps() public {
        address next = makeAddr("nextOwner");
        vm.stopPrank();
        vm.prank(owner);
        vault.transferOwnership(next);
        assertEq(vault.owner(), owner, "not until accepted");
        vm.prank(next);
        vault.acceptOwnership();
        assertEq(vault.owner(), next);
    }

    function test_fee_isOnePercentPlusGas_clampedToTheEntry() public view {
        assertEq(vault.feeOn(10 * USD), 120_000, "$10 -> 10c + 2c");
        assertEq(vault.feeOn(100 * USD), 1_020_000);
        assertEq(vault.feeOn(0), 0, "a free entry pays nothing");
        assertEq(vault.feeOn(20_000), 20_000, "a 2c entry is all fee");
        assertEq(vault.feeOn(10_000), 10_000, "never more than the entry");
        assertEq(vault.feeOn(1), 1);
    }

    // ── creating ────────────────────────────────────────────────────────

    function test_create_onlyOnTermsTheOrganizerSigned() public {
        EventVault.EventTerms memory t = _terms(EVENT, 10 * USD, 4, 4);

        // The server cannot make someone an organizer, nor itself one.
        bytes memory byServer = _sign(serverKey, vault.hashEventTerms(t));
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.createEvent(t, byServer);
        bytes memory sig = _sign(organizerKey, vault.hashEventTerms(t));
        t.entryFee = 11 * USD;
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.createEvent(t, sig);
        t.entryFee = 10 * USD;

        vault.createEvent(t, sig);
        _assertStatus(EventVault.Status.Open);
        EventVault.EventState memory e = vault.eventOf(EVENT);
        assertEq(e.organizer, organizer);
        assertEq(e.entryFee, 10 * USD);
        assertEq(e.minEntrants, 4);
        assertEq(e.resultDeadline, deadline);

        vm.expectRevert(EventVault.EventExists.selector);
        vault.createEvent(t, sig);
    }

    function test_create_refusesBadTerms() public {
        EventVault.EventTerms memory t = _terms(EVENT, 10 * USD, 4, 4);
        t.registrationClosesAt = uint64(block.timestamp);
        _expectBadTerms(t);
        t = _terms(EVENT, 10 * USD, 4, 4);
        t.registrationClosesAt = startsAt + 1;
        _expectBadTerms(t);
        t = _terms(EVENT, 10 * USD, 4, 4);
        t.resultDeadline = startsAt;
        _expectBadTerms(t);
        t = _terms(EVENT, 10 * USD, 4, 4);
        t.resultDeadline = uint64(block.timestamp + 365 days + 1);
        _expectBadTerms(t);
        t = _terms(EVENT, 10 * USD, 4, 4);
        t.organizer = address(0);
        vm.expectRevert(EventVault.ZeroAddress.selector);
        vault.createEvent(t, "");
    }

    function _expectBadTerms(EventVault.EventTerms memory t) internal {
        bytes memory sig = _sign(organizerKey, vault.hashEventTerms(t));
        vm.expectRevert(EventVault.BadTerms.selector);
        vault.createEvent(t, sig);
    }

    // ── registering ─────────────────────────────────────────────────────

    function test_register_takesTheFeeWithoutThePlayerSendingAnything() public {
        _create(10 * USD, 2, 2);
        _enter(0);
        assertEq(usdc.balanceOf(_player(0)), 0);
        assertEq(usdc.balanceOf(address(vault)), 10 * USD);
        assertEq(usdc.allowance(_player(0), address(vault)), 0, "no approval involved");
        assertEq(vm.getNonce(_player(0)), 0, "the player sent no transaction");
        (EventVault.SeatState state,,,, bytes32 team) = vault.seats(EVENT, _player(0));
        assertEq(uint8(state), uint8(EventVault.SeatState.Entered));
        assertEq(team, _solo(0));
        assertEq(vault.eventOf(EVENT).entrants, 1);

        _expect(EventVault.AlreadyEntered.selector);
        _enter(0);
    }

    function test_register_needsTheServersPermit() public {
        _create(10 * USD, 2, 2);
        EventVault.Entry memory entry = _entry(EVENT, 0, _solo(0), false);
        usdc.mint(entry.player, 10 * USD);
        bytes memory pay = _authorize(_key(0), 10 * USD, vault.hashEntry(entry), block.timestamp + 1 hours);

        // Self-issued, or a permit for someone else's entry.
        bytes memory selfIssued = _sign(_key(0), vault.hashEntryPermit(entry));
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.register(entry, selfIssued, pay, 0, block.timestamp + 1 hours);
        bytes memory other = _sign(serverKey, vault.hashEntryPermit(_entry(EVENT, 1, _solo(1), false)));
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.register(entry, other, pay, 0, block.timestamp + 1 hours);
        // The server's signature of the entry itself is not a permit either.
        bytes memory notAPermit = _sign(serverKey, vault.hashEntry(entry));
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.register(entry, notAPermit, pay, 0, block.timestamp + 1 hours);
        assertEq(usdc.balanceOf(entry.player), 10 * USD);
    }

    function test_register_closesWhenRegistrationDoes() public {
        _create(10 * USD, 1, 1);
        _enter(0);
        vm.warp(closesAt);
        _expect(EventVault.RegistrationClosed.selector);
        _enter(1);
    }

    function test_register_refusesAnUnknownEventAndBadEntries() public {
        _expect(EventVault.NotOpen.selector);
        _enter(0);

        _create(10 * USD, 1, 1);
        EventVault.Entry memory entry = _entry(EVENT, 0, bytes32(0), false);
        vm.expectRevert(EventVault.BadEntry.selector);
        vault.register(entry, "", "", 0, 0);
        entry = _entry(EVENT, 0, _solo(0), false);
        entry.attempt = 1;
        vm.expectRevert(EventVault.BadEntry.selector);
        vault.register(entry, "", "", 0, 0);
    }

    function test_register_freeEntryNeedsThePlayersOwnSignature() public {
        _create(0, 2, 2);
        EventVault.Entry memory entry = _entry(EVENT, 0, _solo(0), false);
        bytes memory permit = _sign(serverKey, vault.hashEntryPermit(entry));

        // The server alone cannot enter a player.
        bytes memory byServer = _sign(serverKey, vault.hashEntry(entry));
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.register(entry, permit, byServer, 0, 0);

        vault.register(entry, permit, _sign(_key(0), vault.hashEntry(entry)), 0, 0);
        assertEq(vault.eventOf(EVENT).entrants, 1);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    /// The player's one signature pays for one entry, as they signed it.
    function test_register_paymentIsBoundToTheEntry() public {
        bytes32 other = keccak256("another event");
        _create(10 * USD, 1, 1);
        _create(other, 10 * USD, 1, 1);

        EventVault.Entry memory entry = _entry(EVENT, 0, _solo(0), false);
        usdc.mint(entry.player, 100 * USD);
        uint256 until = block.timestamp + 1 hours;
        bytes memory pay = _authorize(_key(0), 10 * USD, vault.hashEntry(entry), until);

        // Not for another event with the same fee.
        EventVault.Entry memory elsewhere = _entry(other, 0, _solo(0), false);
        bytes memory permit = _sign(serverKey, vault.hashEntryPermit(elsewhere));
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        vault.register(elsewhere, permit, pay, 0, until);

        // Not with another team, and not with the payout routed elsewhere.
        EventVault.Entry memory altered = _entry(EVENT, 0, _solo(1), false);
        permit = _sign(serverKey, vault.hashEntryPermit(altered));
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        vault.register(altered, permit, pay, 0, until);
        altered = _entry(EVENT, 0, _solo(0), true);
        permit = _sign(serverKey, vault.hashEntryPermit(altered));
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        vault.register(altered, permit, pay, 0, until);

        // Not as a prize.
        EventVault.Prize memory prize = EventVault.Prize({
            eventId: EVENT, sponsor: entry.player, amount: 10 * USD, split: _split(10_000, 0, 0), salt: bytes32(0)
        });
        permit = _sign(serverKey, vault.hashPrizePermit(prize));
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        vault.fundPrize(prize, permit, pay, 0, until);

        // Not by anyone calling the token directly: only the vault may spend it.
        (bytes32 r, bytes32 s, uint8 v) = _rsv(pay);
        bytes32 nonce = vault.hashEntry(entry);
        vm.expectRevert(bytes("FiatTokenV2: caller must be the payee"));
        usdc.receiveWithAuthorization(entry.player, address(vault), 10 * USD, 0, until, nonce, v, r, s);

        // As signed, once.
        permit = _sign(serverKey, vault.hashEntryPermit(entry));
        vault.register(entry, permit, pay, 0, until);
        assertEq(usdc.balanceOf(entry.player), 90 * USD);
        assertTrue(usdc.authorizationState(entry.player, nonce));
    }

    function _rsv(bytes memory sig) internal pure returns (bytes32 r, bytes32 s, uint8 v) {
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
    }

    function test_register_refusesAnExpiredOrShortPayment() public {
        _create(10 * USD, 1, 1);
        EventVault.Entry memory entry = _entry(EVENT, 0, _solo(0), false);
        bytes memory permit = _sign(serverKey, vault.hashEntryPermit(entry));
        bytes32 digest = vault.hashEntry(entry);
        uint256 until = block.timestamp + 1 hours;

        // No money.
        bytes memory pay = _authorize(_key(0), 10 * USD, digest, until);
        vm.expectRevert();
        vault.register(entry, permit, pay, 0, until);

        // Signed for less than the fee: the vault asks the token for the full fee.
        usdc.mint(entry.player, 10 * USD);
        pay = _authorize(_key(0), 9 * USD, digest, until);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        vault.register(entry, permit, pay, 0, until);

        pay = _authorize(_key(0), 10 * USD, digest, until);
        vm.warp(until);
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        vault.register(entry, permit, pay, 0, until);
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.register(entry, permit, hex"1234", 0, until);
    }

    // ── leaving ─────────────────────────────────────────────────────────

    function test_leave_refundsInFullAndReopensTheSeat() public {
        _create(10 * USD, 2, 2);
        _enter(0);
        _enter(1);

        _leave(0);
        assertEq(usdc.balanceOf(_player(0)), 10 * USD, "refunded in full, no fee");
        assertEq(usdc.balanceOf(address(vault)), 10 * USD);
        assertEq(vault.eventOf(EVENT).entrants, 1);
        (uint32 members,) = vault.teams(EVENT, _solo(0));
        assertEq(members, 0);
        (EventVault.SeatState state,,, uint32 attempt,) = vault.seats(EVENT, _player(0));
        assertEq(uint8(state), uint8(EventVault.SeatState.Left));
        assertEq(attempt, 1);

        _expect(EventVault.NotEntered.selector);
        _leave(0);
    }

    function test_leave_needsThePlayersSignature_andRegistrationOpen() public {
        _create(10 * USD, 2, 2);
        _enter(0);
        // Neither the server nor the organizer can remove a player.
        bytes32 digest = vault.hashLeave(EVENT, _player(0), 0);
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.leave(EVENT, _player(0), _sign(serverKey, digest));
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.leave(EVENT, _player(0), _sign(organizerKey, digest));

        vm.warp(closesAt);
        _expect(EventVault.RegistrationClosed.selector);
        _leave(0);
    }

    function test_leave_thenEnterAgain_withAFreshSignature() public {
        _create(10 * USD, 2, 2);
        EventVault.Entry memory first = _entry(EVENT, 0, _solo(0), false);
        _enter(0);
        bytes memory leaveSig = _sign(_key(0), vault.hashLeave(EVENT, _player(0), 0));
        vault.leave(EVENT, _player(0), leaveSig);

        // The first entry cannot be replayed: its attempt is spent.
        bytes memory permit = _sign(serverKey, vault.hashEntryPermit(first));
        vm.expectRevert(EventVault.BadEntry.selector);
        vault.register(first, permit, "", 0, 0);

        _enter(0);
        assertEq(usdc.balanceOf(_player(0)), 10 * USD, "the refund, with the new fee paid from new money");
        assertEq(usdc.balanceOf(address(vault)), 10 * USD);
        assertEq(vault.eventOf(EVENT).entrants, 1);

        // Nor can the old leave pull them out again.
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.leave(EVENT, _player(0), leaveSig);
    }

    // ── a ticketed event ────────────────────────────────────────────────

    /// Twenty players at $10: the host receives $197.60, the platform $2.40.
    function test_ticketed_paysTheOrganizerLessTheFee() public {
        _create(10 * USD, 4, 4);
        _enterMany(20);
        assertEq(usdc.balanceOf(address(vault)), 200 * USD);

        _expect(EventVault.TooEarly.selector);
        _post(_none(), 18);
        vm.warp(startsAt);
        vm.expectRevert(EventVault.NotSettled.selector);
        vault.claim(EVENT, organizer);

        _post(_none(), 18);
        _assertStatus(EventVault.Status.Posted);
        vm.expectRevert(EventVault.NotSettled.selector);
        vault.claim(EVENT, organizer);
        assertEq(vault.claimable(EVENT, organizer), 0);
        assertFalse(vault.feesPending(EVENT));

        vm.warp(startsAt + WINDOW);
        _assertStatus(EventVault.Status.Final);
        assertEq(vault.claimable(EVENT, organizer), 197_600_000);
        assertTrue(vault.feesPending(EVENT));
        assertEq(vault.claim(EVENT, organizer), 197_600_000);
        assertEq(usdc.balanceOf(organizer), 197_600_000);
        assertEq(vault.treasuryOwed(), 2_400_000);
        assertFalse(vault.feesPending(EVENT));

        vault.payTreasury();
        assertEq(usdc.balanceOf(treasury), 2_400_000);
        assertEq(usdc.balanceOf(address(vault)), 0);

        // Paid once. A player who came, or did not, is owed nothing back.
        vm.expectRevert(EventVault.NothingOwed.selector);
        vault.claim(EVENT, organizer);
        vm.expectRevert(EventVault.NothingOwed.selector);
        vault.claim(EVENT, _player(0));
        vm.expectRevert(EventVault.NothingOwed.selector);
        vault.payTreasury();
    }

    function test_ticketed_aTinyEntryIsAllFee() public {
        _create(10_000, 1, 1);
        _enterMany(3);
        vm.warp(startsAt);
        _post(_none(), 3);
        vm.warp(startsAt + WINDOW);

        assertEq(vault.claimable(EVENT, organizer), 0);
        assertEq(vault.claim(EVENT, organizer), 0, "nothing for the organizer, but the fee is taken");
        assertEq(vault.treasuryOwed(), 30_000);
        assertEq(usdc.balanceOf(organizer), 0);
        vm.expectRevert(EventVault.NothingOwed.selector);
        vault.claim(EVENT, organizer);
    }

    // ── a competitive event ─────────────────────────────────────────────

    /// Teams of 2, 1 and 3 take 60/30/10 of $200; a fourth team places nowhere.
    function test_competitive_splitsThePrizeAmongPlacedTeams() public {
        bytes32 a = keccak256("team a");
        bytes32 b = keccak256("team b");
        bytes32 c = keccak256("team c");
        bytes32 d = keccak256("team d");
        _create(5 * USD, 4, 4);
        _enter(EVENT, 0, a, false);
        _enter(EVENT, 1, a, false);
        _enter(EVENT, 2, b, false);
        _enter(EVENT, 3, c, false);
        _enter(EVENT, 4, c, false);
        _enter(EVENT, 5, c, false);
        _enter(EVENT, 6, d, false);
        _fund(200 * USD, _split(6000, 3000, 1000));
        assertEq(usdc.balanceOf(address(vault)), 235 * USD);

        vm.warp(startsAt);
        _post(_teams(a, b, c), 7);
        vm.warp(startsAt + WINDOW);

        assertEq(vault.prizeShareOf(EVENT, a), 60 * USD);
        assertEq(vault.prizeShareOf(EVENT, b), 60 * USD);
        assertEq(vault.prizeShareOf(EVENT, c), 6_666_666);
        assertEq(vault.prizeShareOf(EVENT, d), 0);
        assertEq(vault.unusedPrize(EVENT), 2, "third place's rounding");

        for (uint256 i; i < 6; i++) {
            vault.claim(EVENT, _player(i));
        }
        assertEq(usdc.balanceOf(_player(0)), 60 * USD);
        assertEq(usdc.balanceOf(_player(1)), 60 * USD);
        assertEq(usdc.balanceOf(_player(2)), 60 * USD);
        assertEq(usdc.balanceOf(_player(3)), 6_666_666);
        assertEq(usdc.balanceOf(_player(5)), 6_666_666);
        vm.expectRevert(EventVault.NothingOwed.selector);
        vault.claim(EVENT, _player(6));
        vm.expectRevert(EventVault.NothingOwed.selector);
        vault.claim(EVENT, _player(0));

        // Entry fees are not the prize: they go to the organizer, less the fee.
        uint256 fee = vault.feeOn(5 * USD);
        assertEq(fee, 70_000);
        assertEq(vault.claim(EVENT, organizer), 7 * (5 * USD - fee));
        // The prize is not taxed; its rounding goes back to the sponsor.
        assertEq(vault.claim(EVENT, sponsor), 2);
        assertEq(usdc.balanceOf(sponsor), FUNDS - 200 * USD + 2);
        vault.payTreasury();
        assertEq(usdc.balanceOf(treasury), 7 * fee);
        assertEq(usdc.balanceOf(address(vault)), 0);

        (bytes32[] memory placed, bool isFinal) = vault.placementsOf(EVENT);
        assertTrue(isFinal);
        assertEq(placed.length, 3);
        assertEq(placed[0], a);
        assertEq(placed[2], c);
    }

    function test_competitive_freeEntryWithAPrize() public {
        _create(0, 2, 2);
        _enterMany(3);
        _fund(50 * USD, _split(10_000, 0, 0));
        vm.warp(startsAt);
        _post(_teams(_solo(2)), 3);
        vm.warp(startsAt + WINDOW);

        assertEq(vault.claim(EVENT, _player(2)), 50 * USD);
        vm.expectRevert(EventVault.NothingOwed.selector);
        vault.claim(EVENT, organizer);
        assertEq(vault.treasuryOwed(), 0, "no entry fee, no platform fee");
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function test_competitive_aPrizeNeedsPlacings() public {
        _create(5 * USD, 2, 2);
        _enterMany(4);
        _fund(100 * USD, _split(7000, 3000, 0));
        vm.warp(startsAt);

        _expect(EventVault.BadPlacements.selector);
        _post(_none(), 4);
        // More places than the split has.
        _expect(EventVault.BadPlacements.selector);
        _post(_teams(_solo(0), _solo(1), _solo(2)), 4);
        // A team twice, and a team nobody is in.
        _expect(EventVault.BadPlacements.selector);
        _post(_teams(_solo(0), _solo(0)), 4);
        _expect(EventVault.BadPlacements.selector);
        _post(_teams(_solo(0), keccak256("nobody")), 4);

        _post(_teams(_solo(0), _solo(1)), 4);
        _assertStatus(EventVault.Status.Posted);
    }

    /// One place taken of three: the rest of the prize goes back to the
    /// sponsors in proportion to what each put in.
    function test_competitive_unusedPlacesReturnToTheSponsors() public {
        uint256 secondKey = 0x5B06;
        address second = vm.addr(secondKey);
        usdc.mint(second, 100 * USD);
        _create(5 * USD, 2, 2);
        _enterMany(3);
        _fund(300 * USD, _split(6000, 3000, 1000));
        _fundAs(secondKey, 100 * USD, _split(6000, 3000, 1000), bytes32(0));
        assertEq(vault.eventOf(EVENT).prizeTotal, 400 * USD);

        vm.warp(startsAt);
        _post(_teams(_solo(1)), 3);
        vm.warp(startsAt + WINDOW);

        assertEq(vault.claim(EVENT, _player(1)), 240 * USD);
        assertEq(vault.unusedPrize(EVENT), 160 * USD);
        assertEq(vault.claim(EVENT, sponsor), 120 * USD);
        assertEq(vault.claim(EVENT, second), 40 * USD);
        vm.expectRevert(EventVault.NothingOwed.selector);
        vault.claim(EVENT, sponsor);
    }

    function test_fundPrize_firstFundingFixesTheSplit() public {
        _create(5 * USD, 2, 2);
        _expect(EventVault.BadSplit.selector);
        _fund(100 * USD, _split(6000, 3000, 0));
        _expect(EventVault.BadSplit.selector);
        _fund(100 * USD, new uint16[](0));
        uint16[] memory nine = new uint16[](9);
        for (uint256 i; i < 9; i++) {
            nine[i] = i == 0 ? 2000 : 1000;
        }
        _expect(EventVault.BadSplit.selector);
        _fund(100 * USD, nine);

        _fund(100 * USD, _split(7000, 3000, 0));
        _expect(EventVault.SplitMismatch.selector);
        _fundAs(sponsorKey, 50 * USD, _split(10_000, 0, 0), bytes32(uint256(2)));
        _fundAs(sponsorKey, 50 * USD, _split(7000, 3000, 0), bytes32(uint256(2)));
        assertEq(vault.eventOf(EVENT).prizeTotal, 150 * USD);
        (uint256 given,) = vault.sponsors(EVENT, sponsor);
        assertEq(given, 150 * USD);
        assertEq(vault.eventOf(EVENT).split.length, 2);
    }

    function test_fundPrize_needsTheServersPermit_andAmount() public {
        _create(5 * USD, 2, 2);
        EventVault.Prize memory p = EventVault.Prize({
            eventId: EVENT, sponsor: sponsor, amount: 100 * USD, split: _split(10_000, 0, 0), salt: bytes32(0)
        });
        uint256 until = block.timestamp + 1 hours;
        bytes memory pay = _authorize(sponsorKey, 100 * USD, vault.hashPrize(p), until);
        // A stranger cannot fix an event's split by funding it first.
        bytes memory selfIssued = _sign(sponsorKey, vault.hashPrizePermit(p));
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.fundPrize(p, selfIssued, pay, 0, until);

        p.amount = 0;
        vm.expectRevert(EventVault.ZeroAmount.selector);
        vault.fundPrize(p, "", pay, 0, until);
    }

    function test_fundPrize_onlyWhileOpen() public {
        _create(5 * USD, 1, 1);
        _enterMany(2);
        vm.warp(startsAt);
        _post(_none(), 2);
        _expect(EventVault.NotOpen.selector);
        _fund(100 * USD, _split(10_000, 0, 0));
    }

    // ── minimum turnout ─────────────────────────────────────────────────

    /// The contract alone decides this one: no signature from anyone.
    function test_void_whenTooFewRegistered() public {
        _create(10 * USD, 4, 2);
        _enterMany(3);
        _fund(100 * USD, _split(10_000, 0, 0));
        _assertStatus(EventVault.Status.Open);
        vm.warp(startsAt - 1);
        _assertStatus(EventVault.Status.Open);
        vm.expectRevert(EventVault.NotSettled.selector);
        vault.claim(EVENT, _player(0));

        vm.warp(startsAt);
        _assertStatus(EventVault.Status.Void);
        _expect(EventVault.NotOpen.selector);
        _post(_teams(_solo(0)), 3);

        vm.stopPrank();
        vm.prank(makeAddr("anyone"));
        assertEq(vault.claim(EVENT, _player(0)), 10 * USD);
        vm.startPrank(relayer);
        vault.claim(EVENT, _player(1));
        vault.claim(EVENT, _player(2));
        assertEq(vault.claim(EVENT, sponsor), 100 * USD);
        assertEq(usdc.balanceOf(_player(2)), 10 * USD);
        assertEq(usdc.balanceOf(sponsor), FUNDS);
        assertEq(usdc.balanceOf(address(vault)), 0);

        // No fee on a refund, and nothing for the organizer.
        assertEq(vault.treasuryOwed(), 0);
        vm.expectRevert(EventVault.NothingOwed.selector);
        vault.claim(EVENT, organizer);
        vm.expectRevert(EventVault.NothingOwed.selector);
        vault.claim(EVENT, _player(0));
    }

    function test_enoughRegistered_isNotVoidAtTheStart() public {
        _create(10 * USD, 4, 2);
        _enterMany(4);
        vm.warp(startsAt);
        _assertStatus(EventVault.Status.Open);
    }

    /// The server's count of check-ins decides this one.
    function test_void_whenTooFewCheckedIn() public {
        _create(10 * USD, 4, 4);
        _enterMany(6);
        _fund(100 * USD, _split(10_000, 0, 0));
        vm.warp(startsAt);

        // A void result places nobody.
        _expect(EventVault.BadPlacements.selector);
        _post(_teams(_solo(0)), 3);
        _expect(EventVault.BadAttendees.selector);
        _post(_none(), 7);

        _post(_none(), 3);
        _assertStatus(EventVault.Status.Posted);
        vm.warp(startsAt + WINDOW);
        _assertStatus(EventVault.Status.Void);

        for (uint256 i; i < 6; i++) {
            assertEq(vault.claim(EVENT, _player(i)), 10 * USD);
        }
        assertEq(vault.claim(EVENT, sponsor), 100 * USD);
        assertEq(vault.treasuryOwed(), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
        vm.expectRevert(EventVault.NothingOwed.selector);
        vault.claim(EVENT, organizer);
    }

    function test_result_needsBothTheServerAndTheOrganizer() public {
        _create(10 * USD, 2, 2);
        _enterMany(3);
        vm.warp(startsAt);
        bytes32 digest = vault.hashResult(EVENT, _none(), 3, 0);
        bytes memory serverSig = _sign(serverKey, digest);
        bytes memory organizerSig = _sign(organizerKey, digest);

        vm.expectRevert(EventVault.BadSignature.selector);
        vault.postResult(EVENT, _none(), 3, serverSig, serverSig);
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.postResult(EVENT, _none(), 3, organizerSig, organizerSig);
        // The organizer cannot raise the count the server signed.
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.postResult(EVENT, _none(), 2, serverSig, organizerSig);

        vault.postResult(EVENT, _none(), 3, serverSig, organizerSig);
    }

    // ── the correction window ───────────────────────────────────────────

    function test_window_runsFromTheFirstPost() public {
        _create(5 * USD, 2, 2);
        _enterMany(3);
        _fund(90 * USD, _split(10_000, 0, 0));
        vm.warp(startsAt + 10 minutes);
        _post(_teams(_solo(0)), 3);
        assertEq(vault.finalAt(EVENT), startsAt + 10 minutes + WINDOW);

        // A correction 50 minutes in does not buy another hour.
        vm.warp(startsAt + 60 minutes);
        _post(_teams(_solo(1)), 3);
        assertEq(vault.finalAt(EVENT), startsAt + 10 minutes + WINDOW);
        (, uint8 place0) = vault.teams(EVENT, _solo(0));
        (, uint8 place1) = vault.teams(EVENT, _solo(1));
        assertEq(place0, 0, "the corrected-away team is unplaced");
        assertEq(place1, 1);
        (, bool isFinal) = vault.placementsOf(EVENT);
        assertFalse(isFinal);

        vm.warp(startsAt + 10 minutes + WINDOW - 1);
        _assertStatus(EventVault.Status.Posted);
        vm.warp(startsAt + 10 minutes + WINDOW);
        _assertStatus(EventVault.Status.Final);
        _expect(EventVault.NotOpen.selector);
        _post(_teams(_solo(2)), 3);

        vm.expectRevert(EventVault.NothingOwed.selector);
        vault.claim(EVENT, _player(0));
        assertEq(vault.claim(EVENT, _player(1)), 90 * USD);
    }

    /// An earlier signed result cannot be replayed over a correction.
    function test_window_anOldResultCannotBeReplayed() public {
        _create(5 * USD, 2, 2);
        _enterMany(3);
        _fund(90 * USD, _split(10_000, 0, 0));
        vm.warp(startsAt);
        bytes32[] memory first = _teams(_solo(0));
        bytes32 digest = vault.hashResult(EVENT, first, 3, 0);
        bytes memory serverSig = _sign(serverKey, digest);
        bytes memory organizerSig = _sign(organizerKey, digest);
        vault.postResult(EVENT, first, 3, serverSig, organizerSig);
        _post(_teams(_solo(1)), 3);

        vm.expectRevert(EventVault.BadSignature.selector);
        vault.postResult(EVENT, first, 3, serverSig, organizerSig);
    }

    function test_window_aCorrectionCanTurnAVoidIntoARun() public {
        _create(10 * USD, 2, 3);
        _enterMany(4);
        vm.warp(startsAt);
        _post(_none(), 2);
        _post(_none(), 3);
        vm.warp(startsAt + WINDOW);
        _assertStatus(EventVault.Status.Final);
        assertEq(vault.claim(EVENT, organizer), 4 * (10 * USD - 120_000));
    }

    /// A result posted just before the deadline still gets its window.
    function test_window_survivesTheDeadline() public {
        _create(10 * USD, 2, 2);
        _enterMany(2);
        vm.warp(deadline - 1);
        _post(_none(), 2);
        vm.warp(deadline + 10);
        _assertStatus(EventVault.Status.Posted);
        vm.warp(deadline - 1 + WINDOW);
        _assertStatus(EventVault.Status.Final);
    }

    // ── cancelling ──────────────────────────────────────────────────────

    function test_cancel_refundsEveryone() public {
        _create(10 * USD, 2, 2);
        _enterMany(3);
        _fund(100 * USD, _split(10_000, 0, 0));

        bytes32 digest = vault.hashCancel(EVENT);
        vm.expectRevert(EventVault.BadSignature.selector);
        vault.cancel(EVENT, _sign(serverKey, digest));
        vault.cancel(EVENT, _sign(organizerKey, digest));
        _assertStatus(EventVault.Status.Cancelled);

        _expect(EventVault.NotOpen.selector);
        _enter(3);
        _expect(EventVault.NotOpen.selector);
        _leave(0);
        vm.expectRevert(EventVault.NotOpen.selector);
        vault.cancel(EVENT, _sign(organizerKey, digest));

        for (uint256 i; i < 3; i++) {
            assertEq(vault.claim(EVENT, _player(i)), 10 * USD);
        }
        assertEq(vault.claim(EVENT, sponsor), 100 * USD);
        assertEq(vault.treasuryOwed(), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    /// Once a result is posted the organizer cannot cancel the prize away.
    function test_cancel_notAfterAResult() public {
        _create(10 * USD, 2, 2);
        _enterMany(2);
        vm.warp(startsAt);
        _post(_none(), 2);
        bytes memory sig = _sign(organizerKey, vault.hashCancel(EVENT));
        vm.expectRevert(EventVault.NotOpen.selector);
        vault.cancel(EVENT, sig);
        vm.warp(startsAt + WINDOW);
        vm.expectRevert(EventVault.NotOpen.selector);
        vault.cancel(EVENT, sig);
    }

    // ── the deadline ────────────────────────────────────────────────────

    /// The organizer and the server are gone: nobody signs anything, and a
    /// stranger returns every dollar. A routed seat is paid directly here.
    function test_expired_refundsWithNoSignatures() public {
        _create(10 * USD, 2, 2);
        _enter(0);
        _enter(EVENT, 1, _solo(1), true);
        _fund(100 * USD, _split(10_000, 0, 0));

        vm.warp(deadline - 1);
        _assertStatus(EventVault.Status.Open);
        vm.expectRevert(EventVault.NotSettled.selector);
        vault.claim(EVENT, _player(0));
        vm.warp(deadline);
        _assertStatus(EventVault.Status.Expired);
        _expect(EventVault.NotOpen.selector);
        _post(_none(), 2);

        vm.stopPrank();
        vm.startPrank(makeAddr("stranger"));
        assertEq(vault.claim(EVENT, _player(0)), 10 * USD);
        assertEq(vault.claim(EVENT, _player(1)), 10 * USD);
        assertEq(vault.claim(EVENT, sponsor), 100 * USD);
        vm.stopPrank();
        assertEq(usdc.balanceOf(_player(1)), 10 * USD, "paid to the player, not the router");
        assertEq(usdc.balanceOf(router), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(vault.treasuryOwed(), 0);
    }

    // ── routed seats ────────────────────────────────────────────────────

    function test_routed_winningsAndRefundsGoThroughTheRouter() public {
        _create(5 * USD, 1, 1);
        _enter(EVENT, 0, _solo(0), true);
        _enter(EVENT, 1, _solo(1), true);
        _fund(80 * USD, _split(10_000, 0, 0));

        // Leaving pays the routed seat's refund through the router.
        bytes memory leaveSig = _sign(_key(1), vault.hashLeave(EVENT, _player(1), 0));
        vm.expectEmit(true, true, false, true, address(vault));
        emit EventVault.RoutedPayout(EVENT, _player(1), 5 * USD);
        vault.leave(EVENT, _player(1), leaveSig);
        assertEq(usdc.balanceOf(router), 5 * USD);
        assertEq(usdc.balanceOf(_player(1)), 0);

        vm.warp(startsAt);
        _post(_teams(_solo(0)), 1);
        vm.warp(startsAt + WINDOW);
        vm.expectEmit(true, true, false, true, address(vault));
        emit EventVault.RoutedPayout(EVENT, _player(0), 80 * USD);
        vault.claim(EVENT, _player(0));
        assertEq(usdc.balanceOf(router), 85 * USD);
        assertEq(usdc.balanceOf(_player(0)), 0);
    }

    function test_routed_refusedWhenThereIsNoRouter() public {
        vm.stopPrank();
        vault = new EventVault(IERC20(address(usdc)), server, treasury, address(0), FEE_BPS, GAS_FEE, WINDOW, owner);
        vm.startPrank(relayer);
        _create(5 * USD, 1, 1);
        EventVault.Entry memory entry = _entry(EVENT, 0, _solo(0), true);
        vm.expectRevert(EventVault.RoutingDisabled.selector);
        vault.register(entry, "", "", 0, 0);
    }

    /// One account in three roles is paid for all of them in one claim.
    function test_claim_coversEveryRoleOfAnAccount() public {
        // The organizer plays in, and sponsors, their own event.
        _create(10 * USD, 2, 2);
        _enter(EVENT, ORGANIZER_INDEX, keccak256("host team"), false);
        _enter(0);
        usdc.mint(organizer, 50 * USD);
        _fundAs(organizerKey, 50 * USD, _split(8000, 2000, 0), bytes32(0));
        vm.warp(startsAt);
        _post(_teams(keccak256("host team")), 2);
        vm.warp(startsAt + WINDOW);

        // 80% of the prize as the winner, the unused 20% as its sponsor, and both entry fees less the fee.
        uint256 expected = 40 * USD + 10 * USD + 2 * (10 * USD - 120_000);
        assertEq(vault.claimable(EVENT, organizer), expected);
        assertEq(vault.claim(EVENT, organizer), expected);
        assertEq(usdc.balanceOf(address(vault)), vault.treasuryOwed());
    }

    /// A wallet that cannot receive USDC blocks only its own payout.
    function test_claim_aBlockedWalletBlocksOnlyItself() public {
        _create(10 * USD, 5, 2);
        _enterMany(3);
        vm.warp(startsAt);
        usdc.setBlocked(_player(1), true);
        vm.expectRevert(abi.encodeWithSelector(BlockingUSDC.Blocked.selector, _player(1)));
        vault.claim(EVENT, _player(1));
        vault.claim(EVENT, _player(0));
        vault.claim(EVENT, _player(2));
        usdc.setBlocked(_player(1), false);
        vault.claim(EVENT, _player(1));
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    /// Placings with no prize are still a public record.
    function test_placings_withoutAPrize() public {
        _create(10 * USD, 2, 2);
        _enterMany(3);
        vm.warp(startsAt);
        _post(_teams(_solo(2), _solo(0)), 3);
        vm.warp(startsAt + WINDOW);
        (bytes32[] memory placed, bool isFinal) = vault.placementsOf(EVENT);
        assertTrue(isFinal);
        assertEq(placed[0], _solo(2));
        assertEq(placed[1], _solo(0));
        vm.expectRevert(EventVault.NothingOwed.selector);
        vault.claim(EVENT, _player(2));
    }

    // ── any order, to the cent ──────────────────────────────────────────

    /// Whatever order the claims arrive in, everyone gets the same amount
    /// and the vault ends holding nothing but the platform fee.
    function testFuzz_claimOrder(uint256 seed, uint8 players, uint8 placed, uint64 fee, uint64 prize, bool run) public {
        uint256 n = bound(players, 2, 12);
        uint256 entryFee = bound(fee, 0, 50 * USD);
        uint256 pot = bound(prize, 1, 500 * USD);
        _create(entryFee, 2, 2);
        // Teams of up to three: player i is on team i / 3 + 1.
        for (uint256 i; i < n; i++) {
            _enter(EVENT, i, bytes32(i / 3 + 1), false);
        }
        _fund(pot, _split(6000, 3000, 1000));

        vm.warp(startsAt);
        if (run) {
            _post(_firstTeams(bound(placed, 1, 3), (n + 2) / 3), uint32(n));
        } else {
            vault.cancel(EVENT, _sign(organizerKey, vault.hashCancel(EVENT)));
        }
        vm.warp(startsAt + WINDOW);

        uint256 sponsorBefore = usdc.balanceOf(sponsor);
        uint256 total = _claimAllInOrder(seed, n);
        uint256 fees = run ? vault.feeOn(entryFee) * n : 0;
        assertEq(vault.treasuryOwed(), fees);
        // In: every entry fee and the prize. Out: the claims.
        assertEq(usdc.balanceOf(address(vault)), entryFee * n + pot - total);
        assertEq(usdc.balanceOf(address(vault)), fees, "nothing is left but the platform fee");
        if (!run) assertEq(usdc.balanceOf(sponsor), sponsorBefore + pot);
    }

    /// Teams 1..places, capped at how many teams there are.
    function _firstTeams(uint256 places, uint256 teamCount) internal pure returns (bytes32[] memory order) {
        if (places > teamCount) places = teamCount;
        order = new bytes32[](places);
        for (uint256 i; i < places; i++) {
            order[i] = bytes32(i + 1);
        }
    }

    /// Claim for players 0..n-1, the organizer and the sponsor in an order
    /// drawn from `seed`; each must be paid what claimable() said before any
    /// claim was made. Returns the total paid.
    function _claimAllInOrder(uint256 seed, uint256 n) internal returns (uint256 total) {
        address[] memory who = new address[](n + 2);
        uint256[] memory owed = new uint256[](n + 2);
        for (uint256 i; i < n; i++) {
            who[i] = _player(i);
        }
        who[n] = organizer;
        who[n + 1] = sponsor;
        for (uint256 i; i < who.length; i++) {
            owed[i] = vault.claimable(EVENT, who[i]);
            total += owed[i];
        }
        for (uint256 left = who.length; left > 0; left--) {
            uint256 pick = uint256(keccak256(abi.encode(seed, left))) % left;
            address account = who[pick];
            uint256 expected = owed[pick];
            who[pick] = who[left - 1];
            owed[pick] = owed[left - 1];
            if (expected == 0 && !(account == organizer && vault.feesPending(EVENT))) {
                vm.expectRevert(EventVault.NothingOwed.selector);
                vault.claim(EVENT, account);
            } else {
                assertEq(vault.claim(EVENT, account), expected);
            }
        }
    }

    /// With two sponsors the prize's rounding can strand at most one base
    /// unit per sponsor, and never more.
    function testFuzz_twoSponsorsLeaveOnlyDust(uint64 first, uint64 second, uint8 members) public {
        uint256 a = bound(first, 1, 1000 * USD);
        uint256 b = bound(second, 1, 1000 * USD);
        uint256 m = bound(members, 1, 7);
        uint256 secondKey = 0x5B06;
        usdc.mint(vm.addr(secondKey), b);
        _create(0, 1, 1);
        for (uint256 i; i < m; i++) {
            _enter(EVENT, i, bytes32(uint256(1)), false);
        }
        _fund(a, _split(6000, 3000, 1000));
        _fundAs(secondKey, b, _split(6000, 3000, 1000), bytes32(0));
        vm.warp(startsAt);
        _post(_teams(bytes32(uint256(1))), uint32(m));
        vm.warp(startsAt + WINDOW);

        for (uint256 i; i < m; i++) {
            if (vault.claimable(EVENT, _player(i)) != 0) vault.claim(EVENT, _player(i));
        }
        if (vault.claimable(EVENT, sponsor) != 0) vault.claim(EVENT, sponsor);
        if (vault.claimable(EVENT, vm.addr(secondKey)) != 0) vault.claim(EVENT, vm.addr(secondKey));
        assertLe(usdc.balanceOf(address(vault)), 1);
    }

    // ── TypeScript vector (api/web3/events/check.ts computes the same values) ──

    /// The vault sits at a fixed address on Arc testnet's chain id, so every
    /// digest below is a constant that protocol.ts must reproduce.
    function test_vector_matchesTypeScript() public {
        vm.stopPrank();
        address at = 0xe7E0000000000000000000000000000000000002;
        vm.chainId(5_042_002);
        deployCodeTo(
            "EventVault.sol:EventVault", abi.encode(address(usdc), server, treasury, router, FEE_BPS, GAS_FEE, WINDOW, owner), at
        );
        EventVault v = EventVault(at);

        // ids.ts gameKey: keccak256 of the lowercase UUID.
        bytes32 eventId = keccak256(bytes("3f2b8c1e-5d4a-4b6c-9e7f-0123456789ab"));
        assertEq(eventId, 0x6b490ae47c7f8c70f3220d5928509c0916f4df7d71d5e9e74088e293ac024770);
        address player = address(0xa1);
        // A solo player's team key: keccak256 of their address, ABI-encoded.
        bytes32 team = keccak256(abi.encode(player));

        EventVault.EventTerms memory terms = EventVault.EventTerms({
            eventId: eventId,
            organizer: address(0xb1),
            entryFee: 10e6,
            minEntrants: 4,
            minAttendees: 3,
            startsAt: 1_800_000_000,
            registrationClosesAt: 1_799_996_400,
            resultDeadline: 1_800_259_200
        });
        EventVault.Entry memory entry =
            EventVault.Entry({eventId: eventId, player: player, teamKey: team, routed: true, attempt: 2});
        EventVault.Prize memory prize = EventVault.Prize({
            eventId: eventId, sponsor: address(0xc1), amount: 200e6, split: _split(6000, 3000, 1000), salt: bytes32(uint256(7))
        });
        bytes32[] memory placed = _teams(team, keccak256("team b"));

        assertEq(v.domainSeparator(), VECTOR_DOMAIN);
        assertEq(team, VECTOR_TEAM);
        assertEq(v.hashEventTerms(terms), VECTOR_TERMS);
        assertEq(v.hashEntry(entry), VECTOR_ENTRY);
        assertEq(v.hashEntryPermit(entry), VECTOR_ENTRY_PERMIT);
        assertEq(v.hashLeave(eventId, player, 2), VECTOR_LEAVE);
        assertEq(v.hashPrize(prize), VECTOR_PRIZE);
        assertEq(v.hashPrizePermit(prize), VECTOR_PRIZE_PERMIT);
        assertEq(v.hashResult(eventId, placed, 9, 1), VECTOR_RESULT);
        assertEq(v.hashCancel(eventId), VECTOR_CANCEL);
    }

    bytes32 internal constant VECTOR_DOMAIN = 0xf2593530fb2c0bd95f7c0111a52e8f1b7966c66d36a2f857f3df58e48458d16f;
    bytes32 internal constant VECTOR_TEAM = 0xaadc37b8ba5645e62f4546802db221593a94729ccbfc5a97d01365a88f649878;
    bytes32 internal constant VECTOR_TERMS = 0x8a1bbd061409a19f2cc1b7e8a459439048b9031cc893faa763bb5a2c93538075;
    bytes32 internal constant VECTOR_ENTRY = 0x4844397a44e70e47690da05febaf6de40b6f8fa16e05567f71b65829e5a30894;
    bytes32 internal constant VECTOR_ENTRY_PERMIT = 0x14290c7bdf70941138cef41bc26615de5fc997ecb9f9946dd0ba6ef73e104c36;
    bytes32 internal constant VECTOR_LEAVE = 0x1fc848e89dcf98e6bac4af8ac9251ed86c9dfc0abc28de5432acb2dacf4889d3;
    bytes32 internal constant VECTOR_PRIZE = 0x7bbf269abfac484c0c3f5897c343161b398d4f4f67b6096fcc91e50f445a52c1;
    bytes32 internal constant VECTOR_PRIZE_PERMIT = 0x3f492a34811e0f63817406b24bc547376dd6ab331a9ee375fbe0f4126fe65375;
    bytes32 internal constant VECTOR_RESULT = 0x6ad5a840067ece4ca1c2ac19deb5e84cfe7e192c3de82efe5a9ab418a389f3fd;
    bytes32 internal constant VECTOR_CANCEL = 0x36ef63436e060e80eb896856b2701c5f184f08cf60a19d9b390e2fbbccc01574;
}
