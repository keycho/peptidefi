// `biohash peptides` - full market view.
//
// v0.2 mock build: delegates to the JS implementation in
// `../commands.js`, which renders the bundled MOCK_MARKET fixture.
// The TS surface here exists for parity with the other command
// files in this directory; when v0.2 wires the CLI to api.biohash.network,
// this file will gain its own implementation calling api.market() in
// the same shape as peptide.ts / verify.ts.
import { cmdPeptides } from "../commands.js";

export async function peptidesCommand(
  opts: { instant?: boolean } = {},
): Promise<void> {
  await cmdPeptides(opts);
}
