pub mod burn;
pub mod initialize_peg_state;
pub mod initialize_reserve_state;
pub mod mint;
pub mod update;

// Glob re-exports so Anchor's #[program] macro can resolve the
// generated `__client_accounts_*` shims at the crate root via
// `pub use instructions::*` in lib.rs.
pub use burn::*;
pub use initialize_peg_state::*;
pub use initialize_reserve_state::*;
pub use mint::*;
pub use update::*;
