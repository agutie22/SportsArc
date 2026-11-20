// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// SportsArcRecord tests. Offline:
//
//   forge test --match-path test/SportsArcRecord.t.sol
//
// test_typescriptVectors pins the output of api/web3/record/check.ts: the
// server's entry hashes must rebuild here, from the same inputs.

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SportsArcRecord} from "../src/SportsArcRecord.sol";
import {RecordHash} from "../src/record/RecordHash.sol";

contract SportsArcRecordTest is Test {
    SportsArcRecord internal book;
    address internal owner = makeAddr("owner");
    address internal writer = makeAddr("writer");
    bytes32 internal constant KIND = RecordHash.CHECKIN;

    event WriterSet(address indexed writer, bool allowed);
    event Written(bytes32 indexed entry, bytes32 indexed kind, address indexed writer);

    function setUp() public {
        book = new SportsArcRecord(owner, writer);
    }

    function _write(bytes32 entry) internal {
        vm.prank(writer);
        book.write(entry, KIND);
    }

    // ── roles ───────────────────────────────────────────────────────────

    function test_constructor_setsOwnerAndWriter() public view {
        assertEq(book.owner(), owner);
        assertTrue(book.isWriter(writer));
        assertFalse(book.isWriter(owner));
    }

    function test_constructor_zeroWriterMeansNone() public {
        SportsArcRecord bare = new SportsArcRecord(owner, address(0));
        assertFalse(bare.isWriter(address(0)));
        vm.prank(address(0));
        vm.expectRevert(abi.encodeWithSelector(SportsArcRecord.NotWriter.selector, address(0)));
        bare.write(keccak256("r"), KIND);
    }

    function testFuzz_setWriter_onlyOwner(address caller) public {
        vm.assume(caller != owner);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, caller));
        book.setWriter(caller, true);
    }

    function test_setWriter_grantAndRevoke() public {
        address second = makeAddr("second");
        vm.expectEmit(true, false, false, true, address(book));
        emit WriterSet(second, true);
        vm.prank(owner);
        book.setWriter(second, true);

        vm.prank(second);
        book.write(keccak256("a"), KIND);

        vm.prank(owner);
        book.setWriter(second, false);
        vm.prank(second);
        vm.expectRevert(abi.encodeWithSelector(SportsArcRecord.NotWriter.selector, second));
        book.write(keccak256("b"), KIND);
    }

    function test_ownership_isTwoStep() public {
        address next = makeAddr("next");
        vm.prank(owner);
        book.transferOwnership(next);
        assertEq(book.owner(), owner);
        vm.prank(next);
        book.acceptOwnership();
        assertEq(book.owner(), next);
    }

    // ── writing ─────────────────────────────────────────────────────────

    function test_write_recordsAndEmits() public {
        bytes32 entry = keccak256("entry");
        assertEq(book.writtenAt(entry), 0);
        assertFalse(book.isWritten(entry));

        vm.warp(1_790_000_000);
        vm.expectEmit(true, true, true, true, address(book));
        emit Written(entry, KIND, writer);
        _write(entry);

        assertEq(book.writtenAt(entry), 1_790_000_000);
        assertTrue(book.isWritten(entry));
    }

    function testFuzz_write_rejectsNonWriter(address caller, bytes32 entry) public {
        vm.assume(caller != writer && entry != bytes32(0));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(SportsArcRecord.NotWriter.selector, caller));
        book.write(entry, KIND);
        assertEq(book.writtenAt(entry), 0);
    }

    function test_write_rejectsZeroEntryAndKind() public {
        vm.startPrank(writer);
        vm.expectRevert(SportsArcRecord.ZeroEntry.selector);
        book.write(bytes32(0), KIND);
        vm.expectRevert(SportsArcRecord.ZeroKind.selector);
        book.write(keccak256("r"), bytes32(0));
        vm.stopPrank();
        assertEq(book.writtenAt(keccak256("r")), 0);
    }

    /// Once written, an entry's time never changes, whoever tries and whenever.
    function testFuzz_write_isWriteOnce(bytes32 entry, bytes32 otherKind, uint32 later) public {
        vm.assume(entry != bytes32(0) && otherKind != bytes32(0));
        vm.warp(1_000);
        _write(entry);

        vm.warp(1_000 + uint256(later));
        address second = makeAddr("second");
        vm.prank(owner);
        book.setWriter(second, true);
        vm.prank(second);
        vm.expectRevert(abi.encodeWithSelector(SportsArcRecord.AlreadyWritten.selector, entry));
        book.write(entry, otherKind);

        assertEq(book.writtenAt(entry), 1_000);
    }

    /// Entries are independent: writing one says nothing about another.
    function testFuzz_write_onlyThatEntry(bytes32 a, bytes32 b) public {
        vm.assume(a != bytes32(0) && b != bytes32(0) && a != b);
        vm.warp(5_000);
        _write(a);
        assertEq(book.writtenAt(a), 5_000);
        assertEq(book.writtenAt(b), 0);
    }

    function test_write_removingTheWriterKeepsWhatItWrote() public {
        bytes32 entry = keccak256("kept");
        vm.warp(7_000);
        _write(entry);
        vm.prank(owner);
        book.setWriter(writer, false);
        assertEq(book.writtenAt(entry), 7_000);
    }

    // ── checking from facts ─────────────────────────────────────────────

    function testFuzz_fieldLookups_matchTheHash(bytes32 game, bytes32 player, uint64 at, bytes32 flip) public {
        vm.assume(flip != bytes32(0));
        vm.warp(9_000);
        _write(RecordHash.checkIn(game, player, at));
        vm.prank(writer);
        book.write(RecordHash.noShow(game, player, at), RecordHash.NOSHOW);

        assertEq(book.checkInWrittenAt(game, player, at), 9_000);
        assertEq(book.noShowWrittenAt(game, player, at), 9_000);

        // Any changed fact is a different entry.
        assertEq(book.checkInWrittenAt(game ^ flip, player, at), 0);
        assertEq(book.checkInWrittenAt(game, player ^ flip, at), 0);
        assertEq(book.checkInWrittenAt(game, player, at ^ uint64(uint256(flip) | 1)), 0);
    }

    function testFuzz_kinds_neverCollide(bytes32 game, bytes32 player, uint64 at) public view {
        assertTrue(RecordHash.checkIn(game, player, at) != RecordHash.noShow(game, player, at));
        assertEq(book.CHECKIN(), keccak256("checkin"));
        assertEq(book.NOSHOW(), keccak256("noshow"));
    }

    // ── cross-check with api/web3/record/check.ts ──────────────────────

    // Inputs there: games G1, G2 (G2 written mixed-case; keys lowercase it),
    // users U0..U2, salt i = keccak256("sportsarc record test salt <i>").
    bytes32 internal constant TS_KIND = 0xde92b51571f07d688dd9b8f07c35f399fc7d36a60d6c50f61a9822cb9559dcd1;
    bytes32 internal constant TS_G1 = 0x74139a9f2a9182c7db1d3d16c0e11b8a72da8da804d61053bfefb8103207e1de;
    bytes32 internal constant TS_G2 = 0x3f63fe388432900eac8de48dc3c9f7a7f55a1432c9761529c5534b1ae37f9ee7;
    bytes32 internal constant TS_TARGET_PLAYER =
        0xdc75361d4d543ada2c047788c5392e0dcffb89e40b12717f5aa8a323d11ba5b8;
    bytes32 internal constant TS_CHECKIN = 0xd21b654c88b19c1bc3f4c4d9f956ef8bcba7feff5b19576724dcba685ec695d0;
    bytes32 internal constant TS_NOSHOW = 0x924ca9fab0b558e2f45db4f7bccd55ffaf7d2ef8ac2f94779d1cc8e17fda0b60;

    function _player(string memory userId, string memory saltSeed) internal pure returns (bytes32) {
        bytes32 userKey = keccak256(bytes(userId));
        return RecordHash.playerCode(userKey, keccak256(bytes(saltSeed)));
    }

    function test_typescriptVectors() public {
        bytes32 g1 = keccak256(bytes("3f1c2a9e-5b7d-4e8f-9a01-2b3c4d5e6f70"));
        bytes32 g2 = keccak256(bytes("a8b9c0d1-e2f3-4a5b-8c6d-7e8f90a1b2c3"));

        // Each piece on its own, so a mismatch says which one drifted.
        assertEq(RecordHash.CHECKIN, TS_KIND);
        assertEq(book.CHECKIN(), TS_KIND);
        assertEq(g1, TS_G1);
        assertEq(g2, TS_G2);
        bytes32 target = _player("5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716", "sportsarc record test salt 1");
        assertEq(target, TS_TARGET_PLAYER);
        assertEq(RecordHash.checkIn(g1, target, 1789924364), TS_CHECKIN);

        // Written by the server's hash, found again from its facts.
        vm.warp(1_790_000_000);
        _write(TS_CHECKIN);
        assertEq(book.checkInWrittenAt(g1, target, 1789924364), 1_790_000_000);
        assertEq(book.checkInWrittenAt(g1, target, 1789924365), 0);
    }

    /// game and result: new kinds need no new contract function; writtenAt(hash) answers for any kind.
    function test_gameAndResultMatchTypescript() public {
        bytes32 g1 = keccak256(bytes("3f1c2a9e-5b7d-4e8f-9a01-2b3c4d5e6f70"));
        bytes32 host = _player("0d6f4a1e-7c2b-4f3a-9e8d-1a2b3c4d5e6f", "sportsarc record test salt 5");
        bytes32 gameRecord = RecordHash.game(
            g1, keccak256("basketball"), keccak256("7b1e0c4a-2d3f-4e5a-8b6c-9d0e1f2a3b4c"), 1789927200, host
        );
        assertEq(gameRecord, 0x951867459e0ed167674d1833dab165785cbd2eb6dda69994b5551ee81f8d05b1);

        bytes32 player = _player("5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716", "sportsarc record test salt 6");
        bytes32 resultRecord = RecordHash.result(g1, player, 1, 0, 1, 1789936200);
        assertEq(resultRecord, 0xacffe2815d09bbdf246d561e1c6dbc3a67804159ccc27ac10556a7f418fb2f1c);

        vm.warp(1_790_000_000);
        vm.startPrank(writer);
        book.write(gameRecord, RecordHash.GAME);
        book.write(resultRecord, RecordHash.RESULT);
        vm.stopPrank();
        assertEq(book.writtenAt(gameRecord), 1_790_000_000);
        assertEq(book.writtenAt(resultRecord), 1_790_000_000);
        assertEq(book.writtenAt(RecordHash.result(g1, player, 0, 0, 1, 1789936200)), 0, "the other side is another entry");
    }

    function test_presenceMatchesTypescript() public pure {
        bytes32 g1 = keccak256(bytes("3f1c2a9e-5b7d-4e8f-9a01-2b3c4d5e6f70"));
        bytes32 player = _player("c0ffee00-1234-4abc-8def-0123456789ab", "sportsarc record test salt 8");
        assertEq(RecordHash.PRESENCE, keccak256("presence"));
        assertEq(RecordHash.presence(g1, player, 0, 1790018100), 0xa12bde455c8b3e18059a3717e089ec4041f8b2c4e141d3f7ab57e3d107bf699c);
        assertTrue(RecordHash.presence(g1, player, 1, 1790018100) != RecordHash.presence(g1, player, 0, 1790018100));
    }

    bytes32 internal constant TS_STANDING = 0x1bcc4abe1a727c83447229e47fdf309455d1d27db35a81b32229660677c8a33d;
    bytes32 internal constant TS_STANDING_2 = 0x74a7f5ce98ad29b7882e14a960188d3df1675d22d9e604e179582c37793fc815;
    bytes32 internal constant TS_MEMBER = 0x04944e8fdaae6120053ef272266cb0871f91115981bcb184ff03e29daa118b9f;
    bytes32 internal constant TS_SEASON = 0xd8b2a3bb97585fcb2275166fddac0fc34aad2af889619e917cec7686d6381715;
    bytes32 internal constant TS_SEASON_KEY = keccak256(bytes("9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"));
    uint64 internal constant TS_SEASON_FINAL = 1806372000;

    /// standing for both teams (Stage 5), from the inputs in api/web3/record/check.ts.
    function test_standingsMatchTypescript() public pure {
        assertEq(RecordHash.STANDING, keccak256("standing"));
        bytes32 team1 = keccak256(bytes("1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081"));
        bytes32 team2 = keccak256(bytes("f0e1d2c3-b4a5-4968-8776-655443322110"));
        // The results a standing counts, sorted by hash.
        bytes32[] memory results = new bytes32[](2);
        results[0] = keccak256("result two"); // 0x3d37..., the smaller
        results[1] = keccak256("result one");
        bytes32 cited = RecordHash.listHash(results);
        assertEq(RecordHash.standing(TS_SEASON_KEY, team1, 5, 1, 0, 1, cited, TS_SEASON_FINAL), TS_STANDING);
        assertEq(RecordHash.standing(TS_SEASON_KEY, team2, 1, 5, 0, 2, RecordHash.listHash(new bytes32[](0)), TS_SEASON_FINAL), TS_STANDING_2);
        assertTrue(RecordHash.standing(TS_SEASON_KEY, team1, 5, 1, 0, 2, cited, TS_SEASON_FINAL) != TS_STANDING, "another place is another entry");
    }

    /// member and season (Stage 5), from the inputs in api/web3/record/check.ts.
    function test_memberAndSeasonMatchTypescript() public pure {
        assertEq(RecordHash.MEMBER, keccak256("member"));
        assertEq(RecordHash.SEASON, keccak256("season"));
        bytes32 player = _player("5e4d3c2b-1a09-4f8e-8d7c-6b5a49382716", "sportsarc record test salt 9");
        bytes32 team1 = keccak256(bytes("1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081"));
        assertEq(RecordHash.member(TS_SEASON_KEY, team1, player, TS_SEASON_FINAL), TS_MEMBER);
        bytes32[] memory table = new bytes32[](2);
        table[0] = TS_STANDING;
        table[1] = TS_STANDING_2;
        bytes32 organizer = keccak256(bytes("2468ace0-1357-4bdf-8ace-0123456789ab"));
        assertEq(RecordHash.season(TS_SEASON_KEY, organizer, RecordHash.listHash(table), TS_SEASON_FINAL), TS_SEASON);
    }

    /// Like every kind, season entries are written and found by hash with no new contract function.
    function test_seasonEntriesWrite() public {
        vm.warp(1_810_000_000);
        vm.startPrank(writer);
        book.write(TS_STANDING, RecordHash.STANDING);
        book.write(TS_MEMBER, RecordHash.MEMBER);
        book.write(TS_SEASON, RecordHash.SEASON);
        vm.stopPrank();
        assertEq(book.writtenAt(TS_SEASON), 1_810_000_000);
        assertEq(book.writtenAt(TS_STANDING), 1_810_000_000);
        assertEq(book.writtenAt(TS_STANDING_2), 0);
    }

    function test_noShowMatchesTypescript() public pure {
        bytes32 g1 = keccak256(bytes("3f1c2a9e-5b7d-4e8f-9a01-2b3c4d5e6f70"));
        bytes32 player = _player("0d6f4a1e-7c2b-4f3a-9e8d-1a2b3c4d5e6f", "sportsarc record test salt 0");
        assertEq(RecordHash.NOSHOW, keccak256("noshow"));
        assertEq(RecordHash.noShow(g1, player, 1789928100), TS_NOSHOW);
    }
}
