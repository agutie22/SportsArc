// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @notice The part of USDC (EIP-3009) the vault uses to take a payment the
///         payer signed, without the payer sending a transaction.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title EventVault
/// @notice Paid events for SportsArc, in USDC (testnet only): entry fees that
///         pay the organizer, and sponsor prizes that pay the winners.
///
/// An organizer creates an event with an entry fee (which may be zero).
/// Players register by paying the fee. A sponsor may fund a prize. After the
/// event the organizer and the server post the result; once its correction
/// window has passed, the entry fees are released to the organizer less the
/// platform fee, and the prize to the placed teams. If the event does not
/// run, everything goes back to whoever paid it.
///
/// Nobody here sends their own transaction. Every function is callable by
/// anyone and acts only on signatures: the platform's relayer submits the
/// calls and pays the gas. Money comes in through USDC's
/// receiveWithAuthorization, which the payer signs and only this contract
/// can spend; the authorization's nonce must be the digest of what it pays
/// for (an Entry or a Prize), so a signature can pay for that one thing and
/// nothing else, and it also carries the payer's consent to the details
/// (which team, where winnings go).
///
/// Who signs what (EIP-712, this contract's domain unless noted):
///   organizer  EventTerms (to create), Result (with the server), Cancel
///   player     the USDC authorization whose nonce is the Entry digest; or,
///              when the entry fee is zero, the Entry itself; and Leave
///   sponsor    the USDC authorization whose nonce is the Prize digest
///   server     EntryPermit (who may enter: adults only, capacity, team),
///              PrizePermit (which split an event uses), and Result (the
///              number of players who checked in)
/// The organizer signs with their own wallet, so the server cannot name
/// itself organizer of an event and collect its fees.
///
/// When an event runs, and when it does not:
///   Open       created, no result yet.
///   Cancelled  the organizer cancelled before any result. Refundable.
///   Void       fewer than minEntrants were registered at the start (decided
///              by this contract alone), or the final result reports fewer
///              than minAttendees checked in (the server's count). Refundable.
///   Posted     a result is posted and can still be corrected. The window
///              starts at the first post and is not extended by corrections.
///   Final      the window passed with enough attendees. Fees and prize pay out.
///   Expired    no result by resultDeadline. Refundable, with no signature
///              from anyone, so money is never stuck if the organizer or the
///              server disappears.
///
/// Money rules:
///   - A player may leave before registration closes: the fee is paid back
///     at once and the seat reopens.
///   - Refundable: every entry fee goes back to its player and every prize
///     contribution to its sponsor. No platform fee is taken.
///   - Final: entry fees, including those of players who registered and did
///     not come, go to the organizer less the platform fee, which goes to
///     the treasury. Place i of the result takes split[i] of the prize,
///     divided equally among the registered members of the team placed
///     there. Whatever the split leaves unused (places nobody took,
///     rounding) goes back to the sponsors in proportion to what they put in.
///   - The platform fee is per entry: min(entryFee, entryFee * FEE_BPS /
///     10000 + GAS_FEE), both fixed at deploy under hard caps. Prizes are
///     never charged.
///
/// Claims are pulled: claim(eventId, account) pays `account` everything the
/// event owes it, in any role. A wallet that cannot receive USDC only ever
/// blocks its own payout. A player who registered as "routed" is paid
/// through `payoutRouter`, which forwards the money to the chain they chose
/// (RoutedPayout); an Expired event always pays the
/// player directly, since that path must not depend on the platform.
///
/// Teams. Every entry names a team key and results place team keys. A solo
/// event is teams of one. The final placings are readable on chain
/// (placementsOf), so something else can settle from them later.
///
/// The server's signing key can be replaced without a redeploy. The owner
/// (a wallet kept off the server) proposes a new signer, and anyone can
/// apply it once SIGNER_DELAY has passed; until then the owner can cancel.
/// The delay means a stolen owner key cannot quietly install a signer that
/// would attest attendance for an event that never ran: the proposal is
/// public for a day first. The owner has no other power: it cannot move
/// money, change fees or touch an event.
///
/// No personal data on chain: an event is keccak256 of its game's UUID
/// (api/web3/ids.ts), a team is a hash, people are bare wallet addresses.
contract EventVault is EIP712, Ownable2Step {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Cancelled,
        Void,
        Posted,
        Final,
        Expired
    }

    enum SeatState {
        None,
        Entered,
        Left
    }

    struct EventTerms {
        bytes32 eventId;
        address organizer;
        uint256 entryFee;
        uint32 minEntrants;
        uint32 minAttendees;
        uint64 startsAt;
        uint64 registrationClosesAt;
        uint64 resultDeadline;
    }

    struct Entry {
        bytes32 eventId;
        address player;
        bytes32 teamKey;
        /// @dev Pay this seat through the payout router.
        bool routed;
        /// @dev How many times this player has left this event before.
        uint32 attempt;
    }

    struct Prize {
        bytes32 eventId;
        address sponsor;
        uint256 amount;
        /// @dev Basis points per place, first place first; sums to 10000.
        uint16[] split;
        /// @dev Chosen by the sponsor, so one sponsor can fund twice.
        bytes32 salt;
    }

    /// @dev organizer == address(0) means the event does not exist.
    struct EventState {
        address organizer;
        uint64 startsAt;
        uint32 minEntrants;
        uint256 entryFee;
        uint64 registrationClosesAt;
        uint64 resultDeadline;
        uint64 firstPostedAt;
        uint32 minAttendees;
        uint32 entrants;
        uint32 attendees;
        uint32 revision;
        bool cancelled;
        bool organizerPaid;
        uint256 prizeTotal;
        uint16[] split;
        bytes32[] placements;
    }

    struct Seat {
        SeatState state;
        bool routed;
        bool paid;
        uint32 attempt;
        bytes32 teamKey;
    }

    struct Team {
        uint32 members;
        /// @dev 1-based place in the posted result; 0 when not placed.
        uint8 place;
    }

    struct Sponsor {
        uint256 amount;
        bool paid;
    }

    bytes32 public constant EVENT_TERMS_TYPEHASH = keccak256(
        "EventTerms(bytes32 eventId,address organizer,uint256 entryFee,uint32 minEntrants,uint32 minAttendees,uint64 startsAt,uint64 registrationClosesAt,uint64 resultDeadline)"
    );
    bytes32 public constant ENTRY_TYPEHASH =
        keccak256("Entry(bytes32 eventId,address player,bytes32 teamKey,bool routed,uint32 attempt)");
    bytes32 public constant ENTRY_PERMIT_TYPEHASH =
        keccak256("EntryPermit(bytes32 eventId,address player,bytes32 teamKey,bool routed,uint32 attempt)");
    bytes32 public constant LEAVE_TYPEHASH = keccak256("Leave(bytes32 eventId,address player,uint32 attempt)");
    bytes32 public constant PRIZE_TYPEHASH =
        keccak256("Prize(bytes32 eventId,address sponsor,uint256 amount,uint16[] split,bytes32 salt)");
    bytes32 public constant PRIZE_PERMIT_TYPEHASH =
        keccak256("PrizePermit(bytes32 eventId,address sponsor,uint256 amount,uint16[] split,bytes32 salt)");
    bytes32 public constant RESULT_TYPEHASH =
        keccak256("Result(bytes32 eventId,bytes32[] placements,uint32 attendees,uint32 revision)");
    bytes32 public constant CANCEL_TYPEHASH = keccak256("Cancel(bytes32 eventId)");

    /// @notice The platform fee can never be set above 3% plus ten cents an entry.
    uint16 public constant MAX_FEE_BPS = 300;
    uint256 public constant MAX_GAS_FEE = 100_000;
    /// @notice Longest a result may stay open to correction.
    uint64 public constant MAX_CORRECTION_WINDOW = 7 days;
    /// @notice Longest an event may hold money, measured from its creation.
    uint64 public constant MAX_LOCK = 365 days;
    /// @notice Most places a prize can be split across, or a result can list.
    uint256 public constant MAX_PLACES = 8;
    /// @notice How long a proposed signer waits before it can be applied.
    uint64 public constant SIGNER_DELAY = 1 days;

    IERC20 public immutable usdc;
    /// @notice The server key that signs permits and attendance; see proposeSigner.
    address public signer;
    /// @notice A signer proposed by the owner, and when it can be applied; zero when none.
    address public pendingSigner;
    uint64 public signerChangeAt;
    address public immutable treasury;
    /// @notice Where a routed seat's payouts go; address(0) disables routing.
    address public immutable payoutRouter;
    /// @notice The platform's share of each entry fee, in basis points.
    uint16 public immutable FEE_BPS;
    /// @notice The flat part of the platform fee per entry, in USDC base units.
    uint256 public immutable GAS_FEE;
    /// @notice How long after its first post a result can still be corrected.
    uint64 public immutable CORRECTION_WINDOW;

    mapping(bytes32 eventId => EventState) internal _events;
    mapping(bytes32 eventId => mapping(address player => Seat)) public seats;
    mapping(bytes32 eventId => mapping(bytes32 teamKey => Team)) public teams;
    mapping(bytes32 eventId => mapping(address sponsor => Sponsor)) public sponsors;

    /// @notice Platform fees taken and not yet paid out.
    uint256 public treasuryOwed;

    event EventCreated(
        bytes32 indexed eventId,
        address indexed organizer,
        uint256 entryFee,
        uint32 minEntrants,
        uint32 minAttendees,
        uint64 startsAt,
        uint64 registrationClosesAt,
        uint64 resultDeadline
    );
    event Registered(bytes32 indexed eventId, address indexed player, bytes32 indexed teamKey, uint256 entryFee, bool routed);
    event Left(bytes32 indexed eventId, address indexed player, uint256 refund);
    event PrizeFunded(bytes32 indexed eventId, address indexed sponsor, uint256 amount, uint256 prizeTotal);
    event ResultPosted(bytes32 indexed eventId, uint32 revision, uint32 attendees, bytes32[] placements);
    event EventCancelled(bytes32 indexed eventId);
    /// @notice `amount` was paid to (or, for a routed seat, on behalf of) `account`.
    event Claimed(bytes32 indexed eventId, address indexed account, uint256 amount);
    event FeeTaken(bytes32 indexed eventId, uint256 amount);
    event TreasuryPaid(uint256 amount);
    /// @notice `amount` owed to `player` was sent to the payout router.
    event RoutedPayout(bytes32 indexed gameId, address indexed player, uint256 amount);
    event SignerProposed(address indexed signer, uint64 applicableAt);
    event SignerChangeCancelled(address indexed signer);
    event SignerChanged(address indexed previous, address indexed signer);

    error ZeroAddress();
    error FeeTooHigh();
    error BadWindow();
    error BadTerms();
    error EventExists();
    error NotOpen();
    error RegistrationClosed();
    error BadSignature();
    error BadEntry();
    error AlreadyEntered();
    error NotEntered();
    error RoutingDisabled();
    error PaymentNotReceived();
    error ZeroAmount();
    error BadSplit();
    error SplitMismatch();
    error TooEarly();
    error BadAttendees();
    error BadPlacements();
    error NotSettled();
    error NothingOwed();
    error NoSignerChange();
    error SignerChangeNotReady();

    constructor(
        IERC20 usdc_,
        address signer_,
        address treasury_,
        address payoutRouter_,
        uint16 feeBps_,
        uint256 gasFee_,
        uint64 correctionWindow_,
        address owner_
    ) EIP712("SportsArc EventVault", "1") Ownable(owner_) {
        if (address(usdc_) == address(0) || signer_ == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps_ > MAX_FEE_BPS || gasFee_ > MAX_GAS_FEE) revert FeeTooHigh();
        if (correctionWindow_ == 0 || correctionWindow_ > MAX_CORRECTION_WINDOW) revert BadWindow();
        usdc = usdc_;
        signer = signer_;
        treasury = treasury_;
        payoutRouter = payoutRouter_;
        FEE_BPS = feeBps_;
        GAS_FEE = gasFee_;
        CORRECTION_WINDOW = correctionWindow_;
    }

    // ── owner: replacing the signer ─────────────────────────────────────

    /// @notice Propose `next` as the signer. It can be applied after
    ///         SIGNER_DELAY; a new proposal replaces an older one and restarts the wait.
    function proposeSigner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        uint64 at = uint64(block.timestamp) + SIGNER_DELAY;
        pendingSigner = next;
        signerChangeAt = at;
        emit SignerProposed(next, at);
    }

    /// @notice Withdraw the pending proposal.
    function cancelSignerChange() external onlyOwner {
        address pending = pendingSigner;
        if (pending == address(0)) revert NoSignerChange();
        delete pendingSigner;
        delete signerChangeAt;
        emit SignerChangeCancelled(pending);
    }

    /// @notice Make the proposed signer the signer, once its wait is over.
    ///         Callable by anyone, so the server can apply it with the new key.
    function applySignerChange() external {
        address next = pendingSigner;
        if (next == address(0)) revert NoSignerChange();
        if (block.timestamp < signerChangeAt) revert SignerChangeNotReady();
        emit SignerChanged(signer, next);
        signer = next;
        delete pendingSigner;
        delete signerChangeAt;
    }

    // ── organizer ───────────────────────────────────────────────────────

    /// @notice Create an event on the terms its organizer signed.
    function createEvent(EventTerms calldata terms, bytes calldata organizerSig) external {
        if (terms.organizer == address(0)) revert ZeroAddress();
        if (
            terms.registrationClosesAt <= block.timestamp || terms.registrationClosesAt > terms.startsAt
                || terms.resultDeadline <= terms.startsAt || terms.resultDeadline > block.timestamp + MAX_LOCK
        ) revert BadTerms();
        EventState storage e = _events[terms.eventId];
        if (e.organizer != address(0)) revert EventExists();
        _requireSignedBy(terms.organizer, hashEventTerms(terms), organizerSig);

        e.organizer = terms.organizer;
        e.entryFee = terms.entryFee;
        e.minEntrants = terms.minEntrants;
        e.minAttendees = terms.minAttendees;
        e.startsAt = terms.startsAt;
        e.registrationClosesAt = terms.registrationClosesAt;
        e.resultDeadline = terms.resultDeadline;
        emit EventCreated(
            terms.eventId,
            terms.organizer,
            terms.entryFee,
            terms.minEntrants,
            terms.minAttendees,
            terms.startsAt,
            terms.registrationClosesAt,
            terms.resultDeadline
        );
    }

    /// @notice Cancel an event that has no result yet. Everything becomes refundable.
    function cancel(bytes32 eventId, bytes calldata organizerSig) external {
        EventState storage e = _events[eventId];
        if (status(eventId) != Status.Open) revert NotOpen();
        _requireSignedBy(e.organizer, hashCancel(eventId), organizerSig);
        e.cancelled = true;
        emit EventCancelled(eventId);
    }

    /// @notice Post, or within the correction window correct, the result:
    ///         the placed teams in order and how many players checked in.
    ///         Signed by the server (the count) and the organizer (the
    ///         placings). `placements` may be empty when no prize was funded:
    ///         that is a ticketed event saying "it ran". A count below
    ///         minAttendees makes the event void once the window passes.
    function postResult(
        bytes32 eventId,
        bytes32[] calldata placements,
        uint32 attendees,
        bytes calldata serverSig,
        bytes calldata organizerSig
    ) external {
        EventState storage e = _events[eventId];
        {
            Status s = status(eventId);
            if (s != Status.Open && s != Status.Posted) revert NotOpen();
        }
        if (block.timestamp < e.startsAt) revert TooEarly();
        if (attendees > e.entrants) revert BadAttendees();
        if (attendees < e.minAttendees) {
            // Too few came: the event is void, and nobody is placed.
            if (placements.length != 0) revert BadPlacements();
        } else if (e.prizeTotal != 0) {
            if (placements.length == 0 || placements.length > e.split.length) revert BadPlacements();
        } else if (placements.length > MAX_PLACES) {
            revert BadPlacements();
        }
        {
            bytes32 digest = hashResult(eventId, placements, attendees, e.revision);
            _requireSignedBy(signer, digest, serverSig);
            _requireSignedBy(e.organizer, digest, organizerSig);
        }
        _place(eventId, e, placements);
        e.attendees = attendees;
        if (e.firstPostedAt == 0) e.firstPostedAt = uint64(block.timestamp);
        emit ResultPosted(eventId, e.revision, attendees, placements);
        e.revision += 1;
    }

    /// @dev Replace the event's placings: clear the places of the previous
    ///      post, then give each listed team its place.
    function _place(bytes32 eventId, EventState storage e, bytes32[] calldata placements) internal {
        mapping(bytes32 => Team) storage t = teams[eventId];
        uint256 previous = e.placements.length;
        for (uint256 i; i < previous; i++) {
            t[e.placements[i]].place = 0;
        }
        for (uint256 i; i < placements.length; i++) {
            Team storage team = t[placements[i]];
            // A placed team has members, and no team takes two places.
            if (team.members == 0 || team.place != 0) revert BadPlacements();
            team.place = uint8(i + 1);
        }
        e.placements = placements;
    }

    // ── player ──────────────────────────────────────────────────────────

    /// @notice Enter `entry.player` into the event. With an entry fee,
    ///         `playerSig` is the player's USDC receiveWithAuthorization
    ///         signature for exactly the fee, with the Entry digest as its
    ///         nonce, valid between `validAfter` and `validBefore`; with no
    ///         fee it is their signature of the Entry itself. `serverPermit`
    ///         is the server's approval of this entry.
    function register(
        Entry calldata entry,
        bytes calldata serverPermit,
        bytes calldata playerSig,
        uint256 validAfter,
        uint256 validBefore
    ) external {
        bytes32 eventId = entry.eventId;
        address player = entry.player;
        EventState storage e = _events[eventId];
        if (status(eventId) != Status.Open) revert NotOpen();
        if (block.timestamp >= e.registrationClosesAt) revert RegistrationClosed();
        if (player == address(0) || entry.teamKey == bytes32(0)) revert BadEntry();
        if (entry.routed && payoutRouter == address(0)) revert RoutingDisabled();
        Seat storage seat = seats[eventId][player];
        if (seat.state == SeatState.Entered) revert AlreadyEntered();
        if (entry.attempt != seat.attempt) revert BadEntry();
        _requireSignedBy(signer, hashEntryPermit(entry), serverPermit);

        seat.state = SeatState.Entered;
        seat.routed = entry.routed;
        seat.teamKey = entry.teamKey;
        e.entrants += 1;
        teams[eventId][entry.teamKey].members += 1;
        emit Registered(eventId, player, entry.teamKey, e.entryFee, entry.routed);

        bytes32 digest = hashEntry(entry);
        if (e.entryFee == 0) {
            _requireSignedBy(player, digest, playerSig);
        } else {
            _receive(player, e.entryFee, validAfter, validBefore, digest, playerSig);
        }
    }

    /// @notice Give up a seat before registration closes. The entry fee is
    ///         paid back at once and the seat can be taken by someone else.
    function leave(bytes32 eventId, address player, bytes calldata playerSig) external {
        EventState storage e = _events[eventId];
        if (status(eventId) != Status.Open) revert NotOpen();
        if (block.timestamp >= e.registrationClosesAt) revert RegistrationClosed();
        Seat storage seat = seats[eventId][player];
        if (seat.state != SeatState.Entered) revert NotEntered();
        _requireSignedBy(player, hashLeave(eventId, player, seat.attempt), playerSig);

        seat.state = SeatState.Left;
        seat.attempt += 1;
        e.entrants -= 1;
        teams[eventId][seat.teamKey].members -= 1;
        emit Left(eventId, player, e.entryFee);
        if (e.entryFee != 0) _pay(eventId, player, seat.routed, e.entryFee);
    }

    // ── sponsor ─────────────────────────────────────────────────────────

    /// @notice Add `prize.amount` to the event's prize. `sponsorSig` is the
    ///         sponsor's USDC receiveWithAuthorization signature for exactly
    ///         that amount, with the Prize digest as its nonce. The first
    ///         funding fixes the split; later ones must carry the same one.
    function fundPrize(
        Prize calldata prize,
        bytes calldata serverPermit,
        bytes calldata sponsorSig,
        uint256 validAfter,
        uint256 validBefore
    ) external {
        bytes32 eventId = prize.eventId;
        EventState storage e = _events[eventId];
        if (status(eventId) != Status.Open) revert NotOpen();
        if (prize.sponsor == address(0)) revert ZeroAddress();
        if (prize.amount == 0) revert ZeroAmount();
        _requireSignedBy(signer, hashPrizePermit(prize), serverPermit);

        if (e.prizeTotal == 0) {
            _checkSplit(prize.split);
            e.split = prize.split;
        } else if (keccak256(abi.encodePacked(prize.split)) != keccak256(abi.encodePacked(e.split))) {
            revert SplitMismatch();
        }
        e.prizeTotal += prize.amount;
        sponsors[eventId][prize.sponsor].amount += prize.amount;
        emit PrizeFunded(eventId, prize.sponsor, prize.amount, e.prizeTotal);

        _receive(prize.sponsor, prize.amount, validAfter, validBefore, hashPrize(prize), sponsorSig);
    }

    // ── anyone ──────────────────────────────────────────────────────────

    /// @notice Pay `account` everything this event owes it, whatever its
    ///         role: a refund or a prize share as a player, the entry fees
    ///         as organizer, a contribution or its unused part as sponsor.
    ///         Only once the event is Final or refundable.
    function claim(bytes32 eventId, address account) external returns (uint256 paid) {
        EventState storage e = _events[eventId];
        Status s = status(eventId);
        bool ran = s == Status.Final;
        if (!ran && s != Status.Cancelled && s != Status.Void && s != Status.Expired) revert NotSettled();

        // Something is owed when an amount is, or when the fee on the
        // organizer's entries still has to be credited to the treasury.
        bool owed;
        uint256 asPlayer;
        uint256 direct;

        Seat storage seat = seats[eventId][account];
        if (seat.state == SeatState.Entered && !seat.paid) {
            asPlayer = ran ? prizeShareOf(eventId, seat.teamKey) : e.entryFee;
            if (asPlayer != 0) seat.paid = true;
        }
        if (ran && account == e.organizer && !e.organizerPaid) {
            uint256 gross = e.entryFee * e.entrants;
            if (gross != 0) {
                e.organizerPaid = true;
                owed = true;
                uint256 fee = feeOn(e.entryFee) * e.entrants;
                direct = gross - fee;
                treasuryOwed += fee;
                emit FeeTaken(eventId, fee);
            }
        }
        Sponsor storage sp = sponsors[eventId][account];
        if (sp.amount != 0 && !sp.paid) {
            uint256 back = ran ? unusedPrize(eventId) * sp.amount / e.prizeTotal : sp.amount;
            if (back != 0) {
                sp.paid = true;
                direct += back;
            }
        }
        paid = asPlayer + direct;
        if (paid == 0 && !owed) revert NothingOwed();

        emit Claimed(eventId, account, paid);
        // An Expired event must pay without the platform's router.
        if (asPlayer != 0) _pay(eventId, account, seat.routed && s != Status.Expired, asPlayer);
        if (direct != 0) usdc.safeTransfer(account, direct);
    }

    /// @notice Pay the treasury the platform fees taken so far. Callable by anyone.
    function payTreasury() external {
        uint256 owed = treasuryOwed;
        if (owed == 0) revert NothingOwed();
        treasuryOwed = 0;
        emit TreasuryPaid(owed);
        usdc.safeTransfer(treasury, owed);
    }

    // ── views ───────────────────────────────────────────────────────────

    function status(bytes32 eventId) public view returns (Status) {
        EventState storage e = _events[eventId];
        if (e.organizer == address(0)) return Status.None;
        if (e.cancelled) return Status.Cancelled;
        if (e.firstPostedAt != 0) {
            if (block.timestamp < e.firstPostedAt + CORRECTION_WINDOW) return Status.Posted;
            return e.attendees >= e.minAttendees ? Status.Final : Status.Void;
        }
        if (block.timestamp >= e.startsAt && e.entrants < e.minEntrants) return Status.Void;
        if (block.timestamp >= e.resultDeadline) return Status.Expired;
        return Status.Open;
    }

    /// @notice The event's terms, running totals, prize split and posted placings.
    function eventOf(bytes32 eventId) external view returns (EventState memory) {
        return _events[eventId];
    }

    /// @notice The placed teams, first place first. `isFinal` says whether
    ///         they can still change: settle from them only when it is true.
    function placementsOf(bytes32 eventId) external view returns (bytes32[] memory teamKeys, bool isFinal) {
        return (_events[eventId].placements, status(eventId) == Status.Final);
    }

    /// @notice When the posted result becomes final; 0 before any post.
    function finalAt(bytes32 eventId) external view returns (uint64) {
        uint64 first = _events[eventId].firstPostedAt;
        return first == 0 ? 0 : first + CORRECTION_WINDOW;
    }

    /// @notice The platform fee on one entry of `entryFee`.
    function feeOn(uint256 entryFee) public view returns (uint256 fee) {
        fee = entryFee * FEE_BPS / 10_000 + GAS_FEE;
        if (fee > entryFee) fee = entryFee;
    }

    /// @notice What one member of `teamKey` takes from the prize under the
    ///         result as posted; 0 if the team is not placed.
    function prizeShareOf(bytes32 eventId, bytes32 teamKey) public view returns (uint256) {
        EventState storage e = _events[eventId];
        Team storage team = teams[eventId][teamKey];
        if (team.place == 0 || e.prizeTotal == 0) return 0;
        return e.prizeTotal * e.split[team.place - 1] / 10_000 / team.members;
    }

    /// @notice The part of the prize the posted result pays to nobody:
    ///         places left empty and rounding. It goes back to the sponsors.
    function unusedPrize(bytes32 eventId) public view returns (uint256 unused) {
        EventState storage e = _events[eventId];
        unused = e.prizeTotal;
        uint256 placed = e.placements.length;
        for (uint256 i; i < placed; i++) {
            bytes32 teamKey = e.placements[i];
            unused -= prizeShareOf(eventId, teamKey) * teams[eventId][teamKey].members;
        }
    }

    /// @notice What claim(eventId, account) would pay now; 0 if the event is
    ///         not settled or nothing is owed.
    function claimable(bytes32 eventId, address account) external view returns (uint256 owed) {
        EventState storage e = _events[eventId];
        Status s = status(eventId);
        bool ran = s == Status.Final;
        if (!ran && s != Status.Cancelled && s != Status.Void && s != Status.Expired) return 0;
        Seat storage seat = seats[eventId][account];
        if (seat.state == SeatState.Entered && !seat.paid) {
            owed += ran ? prizeShareOf(eventId, seat.teamKey) : e.entryFee;
        }
        if (ran && account == e.organizer && !e.organizerPaid) {
            owed += (e.entryFee - feeOn(e.entryFee)) * e.entrants;
        }
        Sponsor storage sp = sponsors[eventId][account];
        if (sp.amount != 0 && !sp.paid) {
            owed += ran ? unusedPrize(eventId) * sp.amount / e.prizeTotal : sp.amount;
        }
    }

    /// @notice Whether claim(eventId, organizer) still has entry fees to
    ///         release (and the platform fee on them to take).
    function feesPending(bytes32 eventId) external view returns (bool) {
        EventState storage e = _events[eventId];
        return status(eventId) == Status.Final && !e.organizerPaid && e.entryFee * e.entrants != 0;
    }

    function hashEventTerms(EventTerms calldata terms) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    EVENT_TERMS_TYPEHASH,
                    terms.eventId,
                    terms.organizer,
                    terms.entryFee,
                    terms.minEntrants,
                    terms.minAttendees,
                    terms.startsAt,
                    terms.registrationClosesAt,
                    terms.resultDeadline
                )
            )
        );
    }

    /// @notice The Entry digest: the nonce of the USDC authorization that
    ///         pays for it, or what the player signs when the fee is zero.
    function hashEntry(Entry calldata entry) public view returns (bytes32) {
        return _hashTypedDataV4(_entryStruct(ENTRY_TYPEHASH, entry));
    }

    /// @notice What the server signs to approve an entry.
    function hashEntryPermit(Entry calldata entry) public view returns (bytes32) {
        return _hashTypedDataV4(_entryStruct(ENTRY_PERMIT_TYPEHASH, entry));
    }

    function hashLeave(bytes32 eventId, address player, uint32 attempt) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(LEAVE_TYPEHASH, eventId, player, attempt)));
    }

    /// @notice The Prize digest: the nonce of the USDC authorization that funds it.
    function hashPrize(Prize calldata prize) public view returns (bytes32) {
        return _hashTypedDataV4(_prizeStruct(PRIZE_TYPEHASH, prize));
    }

    /// @notice What the server signs to approve a prize and its split.
    function hashPrizePermit(Prize calldata prize) public view returns (bytes32) {
        return _hashTypedDataV4(_prizeStruct(PRIZE_PERMIT_TYPEHASH, prize));
    }

    function hashResult(bytes32 eventId, bytes32[] calldata teamKeys, uint32 attendees, uint32 revision)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(RESULT_TYPEHASH, eventId, keccak256(abi.encodePacked(teamKeys)), attendees, revision))
        );
    }

    function hashCancel(bytes32 eventId) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, eventId)));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ── internals ───────────────────────────────────────────────────────

    function _entryStruct(bytes32 typehash, Entry calldata entry) internal pure returns (bytes32) {
        return keccak256(abi.encode(typehash, entry.eventId, entry.player, entry.teamKey, entry.routed, entry.attempt));
    }

    function _prizeStruct(bytes32 typehash, Prize calldata prize) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                typehash, prize.eventId, prize.sponsor, prize.amount, keccak256(abi.encodePacked(prize.split)), prize.salt
            )
        );
    }

    function _checkSplit(uint16[] calldata split) internal pure {
        if (split.length == 0 || split.length > MAX_PLACES) revert BadSplit();
        uint256 total;
        for (uint256 i; i < split.length; i++) {
            if (split[i] == 0) revert BadSplit();
            total += split[i];
        }
        if (total != 10_000) revert BadSplit();
    }

    /// @dev Take `amount` from `from` with the authorization they signed for
    ///      `nonce`, and check that it arrived.
    function _receive(
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) internal {
        if (signature.length != 65) revert BadSignature();
        uint8 v = uint8(signature[64]);
        if (v < 27) v += 27;
        uint256 before = usdc.balanceOf(address(this));
        IERC3009(address(usdc)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, nonce, v, bytes32(signature[0:32]), bytes32(signature[32:64])
        );
        if (usdc.balanceOf(address(this)) != before + amount) revert PaymentNotReceived();
    }

    /// @dev Pay what `player` is owed: to them, or to the router if they
    ///      routed their seat.
    function _pay(bytes32 eventId, address player, bool routed, uint256 amount) internal {
        if (routed) {
            emit RoutedPayout(eventId, player, amount);
            usdc.safeTransfer(payoutRouter, amount);
        } else {
            usdc.safeTransfer(player, amount);
        }
    }

    function _requireSignedBy(address expected, bytes32 digest, bytes calldata signature) internal pure {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != expected) revert BadSignature();
    }
}
