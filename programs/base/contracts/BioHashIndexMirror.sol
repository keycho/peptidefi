// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { OAppReceiver, Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OAppReceiver.sol";
import { OAppCore } from "@layerzerolabs/oapp-evm/contracts/oapp/OAppCore.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title BioHashIndexMirror
 * @notice Receives BioHash Peptide Index updates from Solana via
 *         LayerZero V2 and stores them on Base. The Solana side is
 *         the canonical source of truth; this contract is a mirror.
 *
 *         Trust model:
 *           - Anyone may read.
 *           - Only the LayerZero V2 endpoint may invoke `lzReceive`,
 *             which is the only way to update state.
 *           - The configured Solana peer (the deployed OApp emitter
 *             program ID) is locked at construction time.
 *           - Ownership is renounced in the constructor; setPeer,
 *             setDelegate, and the rest of OAppCore's onlyOwner
 *             surface are uncallable after deploy.
 *           - The deploy script SHOULD additionally call
 *             endpoint.setDelegate(burnAddress) post-deploy to lock
 *             the LayerZero-side delegate.
 *
 *         Source of canonical truth: the Solana index PDA at
 *         8SZwocjHyuYvK8TvF1Rbjt6Cj2YWMZcU74deumXvGguh, owned by
 *         program HD35yuVU8txZwgary7pTYtNGgoAdtznnFLGoK1huTRqa.
 *
 *         See docs/v1/10-base-mirror.md.
 *
 *         Strawman caveat: the exact OAppReceiver constructor and
 *         _lzReceive signature depend on the LayerZero V2 EVM SDK
 *         version. Verify imports against the LayerZero docs before
 *         compiling.
 *         https://docs.layerzero.network/v2/developers/evm
 */
contract BioHashIndexMirror is OAppReceiver {
    struct IndexEntry {
        uint64 level;            // index level, fixed point with 4 decimals
        uint64 hourStart;        // UTC hour identifier, matches Solana hour_start_unix
        bytes32 componentsHash;  // sha256 of the canonical components vector
        uint64 slot;             // Solana slot at which the source PDA was written
        uint64 receivedAt;       // Base block timestamp when _lzReceive ran
    }

    /// @notice The most recent mirrored entry.
    IndexEntry public latestEntry;

    /// @notice Per-hour history. Keyed by `hourStart`.
    mapping(uint64 => IndexEntry) public entries;

    /// @notice Emitted on every successful mirror. `hourStart` is
    ///         indexed so consumers can filter by hour.
    event IndexMirrored(
        uint64 indexed hourStart,
        uint64 level,
        bytes32 componentsHash,
        uint64 slot,
        uint64 receivedAt
    );

    error InvalidPayloadLength(uint256 length);
    error OutOfOrderHour(uint64 receivedHour, uint64 latestHour);
    error WindowTooLarge(uint64 startHour, uint64 endHour, uint256 maxSize);

    /// @notice Maximum window size for getEntries() to avoid
    ///         unbounded gas costs at view time.
    uint256 public constant MAX_GET_ENTRIES_WINDOW = 256;

    /// @notice Expected payload length: 8 + 8 + 32 + 8 = 56 bytes,
    ///         packed big-endian by the Solana emitter.
    uint256 public constant PAYLOAD_LENGTH = 56;

    /**
     * @param _endpoint   LayerZero V2 endpoint on Base
     * @param _solanaEid  Solana mainnet EID (LayerZero constant)
     * @param _solanaPeer 32-byte LayerZero-canonical address of the
     *                    Solana emitter OApp store PDA
     * @param _delegate   LayerZero delegate. Pass a burn address (e.g.
     *                    0x000000000000000000000000000000000000dEaD)
     *                    for an immutable deploy, or msg.sender if
     *                    you intend to configure libraries before
     *                    locking via endpoint.setDelegate.
     */
    constructor(
        address _endpoint,
        uint32 _solanaEid,
        bytes32 _solanaPeer,
        address _delegate
    ) OAppCore(_endpoint, _delegate) Ownable(msg.sender) {
        // Lock the Solana peer at construction time. Bypasses
        // onlyOwner via the internal setter so the call survives
        // the renounceOwnership below.
        _setPeer(_solanaEid, _solanaPeer);
        // Renounce ownership immediately. setPeer, setDelegate, and
        // the rest of OAppCore's onlyOwner surface become uncallable.
        _transferOwnership(address(0));
    }

    /**
     * @notice LayerZero entry point. Called by the configured
     *         endpoint after DVN verification + executor delivery.
     *         The endpoint's `lzReceive` wrapper (in OAppReceiver)
     *         validates msg.sender and the source peer; we only
     *         reach this internal function once that has passed.
     */
    function _lzReceive(
        Origin calldata, /* _origin */
        bytes32, /* _guid */
        bytes calldata _message,
        address, /* _executor */
        bytes calldata /* _extraData */
    ) internal override {
        if (_message.length != PAYLOAD_LENGTH) {
            revert InvalidPayloadLength(_message.length);
        }

        // Decode the 56-byte big-endian payload packed by the Solana
        // emitter. Layout: level (8), hourStart (8), componentsHash
        // (32), slot (8).
        uint64 level = uint64(bytes8(_message[0:8]));
        uint64 hourStart = uint64(bytes8(_message[8:16]));
        bytes32 componentsHash = bytes32(_message[16:48]);
        uint64 slot = uint64(bytes8(_message[48:56]));

        if (hourStart <= latestEntry.hourStart) {
            revert OutOfOrderHour(hourStart, latestEntry.hourStart);
        }

        uint64 receivedAt = uint64(block.timestamp);
        IndexEntry memory entry = IndexEntry({
            level: level,
            hourStart: hourStart,
            componentsHash: componentsHash,
            slot: slot,
            receivedAt: receivedAt
        });

        latestEntry = entry;
        entries[hourStart] = entry;

        emit IndexMirrored(hourStart, level, componentsHash, slot, receivedAt);
    }

    /**
     * @notice Read the most recent mirrored entry. Identical to
     *         `latestEntry` but returns a struct (the public auto-
     *         getter on `latestEntry` returns a tuple).
     */
    function latest() external view returns (IndexEntry memory) {
        return latestEntry;
    }

    /**
     * @notice Read one historical entry by `hourStart`. Returns a
     *         zero-initialised struct if no entry exists for that
     *         hour; consumers should check `entry.receivedAt != 0`.
     */
    function getEntry(uint64 hourStart) external view returns (IndexEntry memory) {
        return entries[hourStart];
    }

    /**
     * @notice Read a window of historical entries. Bounded to
     *         MAX_GET_ENTRIES_WINDOW to avoid unbounded gas.
     *         hourStart values may not be contiguous; a cohort-
     *         incomplete hour on Solana is skipped entirely and
     *         leaves no entry on Base. Consumers should iterate
     *         and skip zero-receivedAt entries.
     *
     * @param startHour Inclusive lower bound (in seconds).
     * @param endHour   Inclusive upper bound (in seconds). MUST
     *                  satisfy `endHour >= startHour` and `endHour -
     *                  startHour < MAX_GET_ENTRIES_WINDOW * 3600`.
     *                  The window is over 256 candidate hours, not
     *                  256 returned entries.
     */
    function getEntries(uint64 startHour, uint64 endHour)
        external
        view
        returns (IndexEntry[] memory)
    {
        if (endHour < startHour) {
            revert WindowTooLarge(startHour, endHour, 0);
        }
        // Window size in candidate hours. Capped to avoid gas blowups.
        uint256 hours_ = (uint256(endHour) - uint256(startHour)) / 3600 + 1;
        if (hours_ > MAX_GET_ENTRIES_WINDOW) {
            revert WindowTooLarge(startHour, endHour, MAX_GET_ENTRIES_WINDOW);
        }
        IndexEntry[] memory out = new IndexEntry[](hours_);
        // We do not know which `hourStart` values actually have
        // entries (cohort-incomplete hours are skipped on Solana).
        // Caller must iterate and check `receivedAt != 0`.
        uint64 cursor = startHour;
        for (uint256 i = 0; i < hours_; i++) {
            out[i] = entries[cursor];
            cursor += 3600;
        }
        return out;
    }
}
