// create_token_metadata — invokes Metaplex Token Metadata's
// CreateMetadataAccountV3 via CPI, signed by the peg_state PDA as the
// peptide token's mint authority.
//
// Why this lives in the peg program at all: Metaplex's metadata-create
// flow requires the mint authority to sign. Our mint authority is the
// peg_state PDA — only the peg program can sign for it via
// invoke_signed. So an off-chain script can't call Metaplex directly;
// it has to route through this instruction.
//
// The metadata's update_authority is set to the `payer` (i.e. the peg
// deployer wallet, in practice). After creation, the deployer can
// update name/symbol/URI directly via Metaplex without needing
// another peg-program upgrade.
//
// One-shot: Metaplex reverts on duplicate creation, so calling this
// twice on the same mint fails cleanly with no on-chain state change.

use anchor_lang::prelude::*;
use anchor_spl::metadata::{
    create_metadata_accounts_v3,
    mpl_token_metadata::types::DataV2,
    CreateMetadataAccountsV3,
    Metadata,
};
use anchor_spl::token::Mint;

use crate::state::PegState;

#[derive(Accounts)]
pub struct CreateTokenMetadata<'info> {
    /// Pays for metadata account creation. Signs the tx and is also
    /// passed as the metadata's update_authority — single signature
    /// satisfies both roles since they're the same account.
    #[account(mut)]
    pub payer: Signer<'info>,

    /// peg_state PDA — the SPL Mint's mint_authority. Provides the
    /// invoke_signed signature for the Metaplex CPI.
    #[account(
        seeds = [b"peg_state", peg_state.peptide_code.as_ref()],
        bump = peg_state.bump,
    )]
    pub peg_state: Box<Account<'info, PegState>>,

    /// Peptide token mint. peg_state must be its mint_authority
    /// (verified at peg init time via initialize_peg_state's
    /// MintAuthorityMismatch check).
    #[account(mut, address = peg_state.peptide_token_mint)]
    pub peptide_token_mint: Box<Account<'info, Mint>>,

    /// The metadata account itself — a PDA off the Metaplex program at
    /// seeds [b"metadata", METAPLEX_PROGRAM_ID, mint]. Created by the
    /// CPI; reverts if it already exists.
    /// CHECK: Metaplex internally verifies the PDA derivation against
    /// the canonical seed pattern — we don't re-check here because
    /// any mismatch makes the CPI fail.
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    pub token_metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn create_token_metadata_handler(
    ctx: Context<CreateTokenMetadata>,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    // Metaplex hard-caps these at 32 / 10 / 200 chars respectively;
    // pre-check off-chain to surface clearer errors than the deep
    // CPI revert message.
    require!(name.len() <= 32, crate::errors::PegError::ZeroAmount);
    require!(symbol.len() <= 10, crate::errors::PegError::ZeroAmount);
    require!(uri.len() <= 200, crate::errors::PegError::ZeroAmount);

    let peptide_code = ctx.accounts.peg_state.peptide_code;
    let bump = ctx.accounts.peg_state.bump;
    let signer_seeds: &[&[&[u8]]] =
        &[&[b"peg_state", peptide_code.as_ref(), &[bump]]];

    let data = DataV2 {
        name,
        symbol,
        uri,
        seller_fee_basis_points: 0,
        creators: None,
        collection: None,
        uses: None,
    };

    create_metadata_accounts_v3(
        CpiContext::new_with_signer(
            ctx.accounts.token_metadata_program.to_account_info(),
            CreateMetadataAccountsV3 {
                metadata: ctx.accounts.metadata.to_account_info(),
                mint: ctx.accounts.peptide_token_mint.to_account_info(),
                mint_authority: ctx.accounts.peg_state.to_account_info(),
                payer: ctx.accounts.payer.to_account_info(),
                update_authority: ctx.accounts.payer.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            signer_seeds,
        ),
        data,
        true,  // is_mutable — lets the deployer update name/symbol/URI later
        true,  // update_authority_is_signer — satisfied by `payer` signing the tx
        None,  // collection_details
    )?;

    Ok(())
}
