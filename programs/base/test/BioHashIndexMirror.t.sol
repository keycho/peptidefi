// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { BioHashIndexMirror } from "../contracts/BioHashIndexMirror.sol";
import { Origin } from "@layerzerolabs/oapp-evm/contracts/oapp/OAppReceiver.sol";

/**
 * Mock LayerZero V2 endpoint. Surfaces just enough of the endpoint
 * API for the mirror to deploy and for tests to call `lzReceive`
 * directly with vm.prank(address(endpoint)).
 *
 * Real endpoint:
 * https://github.com/LayerZero-Labs/LayerZero-v2/blob/main/protocol/contracts/EndpointV2.sol
 *
 * The mirror calls endpoint.setDelegate(_delegate) in OAppCore's
 * constructor. The mock just accepts the call.
 */
contract MockEndpoint {
    address public lastDelegateSetBy;
    address public lastDelegate;

    function setDelegate(address _delegate) external {
        lastDelegateSetBy = msg.sender;
        lastDelegate = _delegate;
    }
}

contract BioHashIndexMirrorTest is Test {
    BioHashIndexMirror internal mirror;
    MockEndpoint internal endpoint;

    /// LayerZero Solana mainnet EID. The Solana emitter sends from
    /// this srcEid; the mirror trusts only this EID + the configured
    /// peer.
    uint32 internal constant SOLANA_EID = 30168;
    /// LayerZero-canonical address of the Solana emitter OApp store
    /// PDA, 32 bytes. For the test fixture we use a deterministic
    /// non-zero value.
    bytes32 internal constant SOLANA_PEER =
        bytes32(uint256(0x424f494248415348313131313131313131313131313131313131313131313131));
    address internal constant DELEGATE = address(0xdEaD);

    function setUp() public {
        endpoint = new MockEndpoint();
        mirror = new BioHashIndexMirror(
            address(endpoint),
            SOLANA_EID,
            SOLANA_PEER,
            DELEGATE
        );
        // The mirror calls endpoint.setDelegate(DELEGATE) in the
        // OAppCore constructor; the mock records it.
        assertEq(endpoint.lastDelegate(), DELEGATE);
        // Ownership is renounced in the mirror's constructor.
        assertEq(mirror.owner(), address(0));
    }

    function _pack(
        uint64 level,
        uint64 hourStart,
        bytes32 componentsHash,
        uint64 slot
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(level, hourStart, componentsHash, slot);
    }

    function _origin(uint32 eid, bytes32 sender, uint64 nonce)
        internal
        pure
        returns (Origin memory)
    {
        return Origin({ srcEid: eid, sender: sender, nonce: nonce });
    }

    function _callLzReceive(
        uint32 srcEid,
        bytes32 sender,
        uint64 nonce,
        bytes memory message
    ) internal {
        // Impersonate the endpoint, as OAppReceiver's lzReceive
        // wrapper enforces msg.sender == endpoint.
        vm.prank(address(endpoint));
        mirror.lzReceive(
            _origin(srcEid, sender, nonce),
            bytes32(uint256(0xdeadbeef)),
            message,
            address(this),
            bytes("")
        );
    }

    function test_receivesValidMessage() public {
        uint64 level = 9_804_600; // 980.46
        uint64 hourStart = 1_715_961_600;
        bytes32 componentsHash = keccak256("biohash-test-1");
        uint64 slot = 419_467_611;

        bytes memory payload = _pack(level, hourStart, componentsHash, slot);

        vm.expectEmit(true, false, false, true);
        emit BioHashIndexMirror.IndexMirrored(
            hourStart,
            level,
            componentsHash,
            slot,
            uint64(block.timestamp)
        );

        _callLzReceive(SOLANA_EID, SOLANA_PEER, 1, payload);

        BioHashIndexMirror.IndexEntry memory entry = mirror.latest();
        assertEq(entry.level, level);
        assertEq(entry.hourStart, hourStart);
        assertEq(entry.componentsHash, componentsHash);
        assertEq(entry.slot, slot);
        assertEq(uint256(entry.receivedAt), block.timestamp);

        BioHashIndexMirror.IndexEntry memory stored = mirror.getEntry(hourStart);
        assertEq(stored.level, level);
        assertEq(stored.hourStart, hourStart);
    }

    function test_rejectsOutOfOrderHour() public {
        uint64 firstHour = 1_715_961_600;
        uint64 secondHour = firstHour + 3600;

        // Forward direction: ok.
        _callLzReceive(
            SOLANA_EID,
            SOLANA_PEER,
            1,
            _pack(9_804_600, secondHour, keccak256("h2"), 419_467_611)
        );

        // Backward direction: must revert OutOfOrderHour.
        vm.expectRevert(
            abi.encodeWithSelector(
                BioHashIndexMirror.OutOfOrderHour.selector,
                firstHour,
                secondHour
            )
        );
        _callLzReceive(
            SOLANA_EID,
            SOLANA_PEER,
            2,
            _pack(9_800_000, firstHour, keccak256("h1"), 419_400_000)
        );

        // Equal hour: must also revert.
        vm.expectRevert(
            abi.encodeWithSelector(
                BioHashIndexMirror.OutOfOrderHour.selector,
                secondHour,
                secondHour
            )
        );
        _callLzReceive(
            SOLANA_EID,
            SOLANA_PEER,
            3,
            _pack(9_900_000, secondHour, keccak256("h2-replay"), 419_500_000)
        );
    }

    function test_rejectsUnauthorizedPeer() public {
        bytes32 imposter = bytes32(uint256(0xDEADBEEF));
        bytes memory payload =
            _pack(9_804_600, 1_715_961_600, keccak256("from-imposter"), 419_467_611);

        // OAppReceiver's lzReceive checks _getPeerOrRevert(_origin.srcEid)
        // == _origin.sender. The configured peer for SOLANA_EID is
        // SOLANA_PEER; an imposter sender must revert.
        vm.prank(address(endpoint));
        vm.expectRevert();
        mirror.lzReceive(
            _origin(SOLANA_EID, imposter, 1),
            bytes32(uint256(0xfeedface)),
            payload,
            address(this),
            bytes("")
        );

        // A different srcEid with no configured peer must also revert
        // (peer slot is the zero bytes32 by default).
        vm.prank(address(endpoint));
        vm.expectRevert();
        mirror.lzReceive(
            _origin(SOLANA_EID + 1, SOLANA_PEER, 1),
            bytes32(uint256(0xfeedface)),
            payload,
            address(this),
            bytes("")
        );
    }

    function test_rejectsNonEndpointCaller() public {
        bytes memory payload =
            _pack(9_804_600, 1_715_961_600, keccak256("not-endpoint"), 419_467_611);

        // Any address other than the endpoint must be rejected by
        // OAppReceiver's OnlyEndpoint guard.
        vm.expectRevert();
        mirror.lzReceive(
            _origin(SOLANA_EID, SOLANA_PEER, 1),
            bytes32(uint256(0xc0ffee)),
            payload,
            address(this),
            bytes("")
        );
    }

    function test_rejectsBadPayloadLength() public {
        bytes memory shortPayload = abi.encodePacked(uint64(1), uint64(2));
        vm.prank(address(endpoint));
        vm.expectRevert(
            abi.encodeWithSelector(
                BioHashIndexMirror.InvalidPayloadLength.selector,
                shortPayload.length
            )
        );
        mirror.lzReceive(
            _origin(SOLANA_EID, SOLANA_PEER, 1),
            bytes32(uint256(0xabad1dea)),
            shortPayload,
            address(this),
            bytes("")
        );
    }

    function test_gasMeasurement_lzReceive() public {
        bytes memory payload =
            _pack(9_804_600, 1_715_961_600, keccak256("gas"), 419_467_611);

        vm.prank(address(endpoint));
        uint256 gasBefore = gasleft();
        mirror.lzReceive(
            _origin(SOLANA_EID, SOLANA_PEER, 1),
            bytes32(uint256(0xfa11b007)),
            payload,
            address(this),
            bytes("")
        );
        uint256 used = gasBefore - gasleft();
        // Sanity floor + ceiling. Tune after first deploy with the
        // actual measured value; this guards against accidental
        // regressions when the contract evolves.
        assertLt(used, 200_000, "lzReceive exceeded 200k gas budget");
        emit log_named_uint("lzReceive gas used", used);
    }

    function test_getEntriesReturnsContiguousWindow() public {
        uint64 baseHour = 1_715_961_600;
        bytes32 h;

        // Land 3 entries at H, H+3600, H+7200.
        for (uint64 i = 0; i < 3; i++) {
            h = keccak256(abi.encodePacked("hour", i));
            _callLzReceive(
                SOLANA_EID,
                SOLANA_PEER,
                uint64(i + 1),
                _pack(uint64(9_800_000 + i), baseHour + i * 3600, h, uint64(i))
            );
        }

        BioHashIndexMirror.IndexEntry[] memory entries =
            mirror.getEntries(baseHour, baseHour + 3 * 3600);
        // 4 candidate hours requested; only 3 have data. The 4th
        // returns a zero-initialised struct (receivedAt == 0).
        assertEq(entries.length, 4);
        assertEq(entries[0].hourStart, baseHour);
        assertEq(entries[1].hourStart, baseHour + 3600);
        assertEq(entries[2].hourStart, baseHour + 7200);
        assertEq(entries[3].receivedAt, 0);
    }

    function test_getEntriesRejectsOversizedWindow() public {
        vm.expectRevert();
        // 257 candidate hours = MAX_GET_ENTRIES_WINDOW + 1
        mirror.getEntries(0, 257 * 3600);
    }
}
