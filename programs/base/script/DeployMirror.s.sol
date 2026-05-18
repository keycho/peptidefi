// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console2 } from "forge-std/Script.sol";
import { BioHashIndexMirror } from "../contracts/BioHashIndexMirror.sol";

/**
 * Deploy the BioHashIndexMirror to Base mainnet.
 *
 * USAGE
 *
 *   Dry run (default):
 *     forge script programs/base/script/DeployMirror.s.sol \
 *       --rpc-url $BASE_RPC_URL
 *
 *   Live (broadcasts, real money):
 *     forge script programs/base/script/DeployMirror.s.sol \
 *       --rpc-url $BASE_RPC_URL \
 *       --private-key $DEPLOYER_PRIVATE_KEY \
 *       --broadcast \
 *       --verify
 *
 *   Verification on Basescan needs BASESCAN_API_KEY in env.
 *
 * REQUIRED ENV
 *
 *   BASE_LZ_ENDPOINT       - LayerZero V2 endpoint on Base mainnet.
 *                            Reference docs/v1/10-base-mirror.md and
 *                            https://docs.layerzero.network/v2/deployments/deployed-contracts
 *                            Verify the exact address before mainnet broadcast.
 *
 *   SOLANA_EID             - Solana mainnet endpoint ID (LayerZero V2 constant).
 *                            For Base ↔ Solana mainnet this is 30168.
 *
 *   SOLANA_PEER_BYTES32    - 32-byte address of the Solana OApp emitter
 *                            store PDA. NOT the program ID. Derived from
 *                            seeds ["oapp_store"] under the deployed
 *                            biohash_index_lz_emitter program. The deploy
 *                            script in
 *                            programs/biohash_index_lz_emitter/scripts/deploy.ts
 *                            prints this value.
 *
 *   LZ_DELEGATE            - LayerZero delegate at deploy time. For an
 *                            immutable deploy, pass a burn address
 *                            (e.g. 0x000000000000000000000000000000000000dEaD).
 *                            Note: a non-zero delegate is required by
 *                            OAppCore; passing the deployer keeps you
 *                            able to configure libraries until you
 *                            later call endpoint.setDelegate(burnAddr).
 *
 * SAFETY
 *
 *   This script has no in-script confirmation prompt; Foundry's
 *   convention is that `--broadcast` is the explicit go-signal.
 *   Always run without `--broadcast` first to verify the
 *   constructor args are correct.
 *
 *   The constructor renounces ownership immediately, so a wrong
 *   peer at deploy time is permanent (redeploy required).
 */
contract DeployMirror is Script {
    function run() external returns (BioHashIndexMirror mirror) {
        address endpoint = vm.envAddress("BASE_LZ_ENDPOINT");
        uint32 solanaEid = uint32(vm.envUint("SOLANA_EID"));
        bytes32 solanaPeer = vm.envBytes32("SOLANA_PEER_BYTES32");
        address delegate = vm.envAddress("LZ_DELEGATE");

        require(endpoint != address(0), "BASE_LZ_ENDPOINT not set");
        require(solanaEid != 0, "SOLANA_EID not set");
        require(solanaPeer != bytes32(0), "SOLANA_PEER_BYTES32 not set");
        require(delegate != address(0), "LZ_DELEGATE must be non-zero (OAppCore requires it)");

        console2.log("=== BioHashIndexMirror deployment ===");
        console2.log("endpoint:    ", endpoint);
        console2.log("solana eid:  ", solanaEid);
        console2.log("delegate:    ", delegate);
        console2.log("");
        console2.log("solana peer (bytes32):");
        console2.logBytes32(solanaPeer);
        console2.log("");

        vm.startBroadcast();
        mirror = new BioHashIndexMirror(endpoint, solanaEid, solanaPeer, delegate);
        vm.stopBroadcast();

        console2.log("=== Deployed ===");
        console2.log("mirror address:", address(mirror));
        console2.log("");
        console2.log("Next steps:");
        console2.log("  1. Verify on Basescan with `forge verify-contract`");
        console2.log("  2. Set the Solana peer on the Solana emitter:");
        console2.log("     LZ_BASE_PEER_ADDRESS=<this address> + run init_peer");
        console2.log("  3. Configure LayerZero send/receive libraries");
        console2.log("     and the LayerZero Labs DVN on both sides");
        console2.log("  4. To lock the deployment fully immutable, call:");
        console2.log("     endpoint.setDelegate(0x000000000000000000000000000000000000dEaD)");
        console2.log("     from the delegate (msg.sender) address.");
        console2.log("");
    }
}
