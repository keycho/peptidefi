// Mock fixtures matching the real /v1 API response shapes.
// Replace with @biohashnetwork/sdk calls in production.

// Real mainnet stats current as of 2026-05-17.
export const MAINNET_STATS = {
  cycle: 2005,
  twap_commits: 58145,
  current_slot: 420362835,
  cohort_size: 29,
  tracked_size: 46,
  vendor_count: 12,
  hourly_cadence_min: 11,
};

export const MOCK_INDEX = {
  level: 963.39,
  baseline: 1000.00,
  baseline_date: '2026-05-03',
  change_pct: -3.66,
  cohort_size: 29,
  hour_start: '2026-05-17T20:00:00.000Z',
  components_hash: '5f3d35b3353d523ee815723b6153ac28c8fbde6a8769ca96c5a2b1bc77283942',
  signed_by: 'FmBggsBjzGsHrtMayYG8ix2JzoYhVczrwJaGGKPpNKK7',
};

export const MOCK_INDEX_HISTORY = [
  { date: '2026-05-11', level: 1000.00 },
  { date: '2026-05-12', level: 995.42 },
  { date: '2026-05-13', level: 991.18 },
  { date: '2026-05-14', level: 987.65 },
  { date: '2026-05-15', level: 978.92 },
  { date: '2026-05-16', level: 970.04 },
  { date: '2026-05-17', level: 963.39 },
];

export const MOCK_PEPTIDES = {
  bpc157: {
    code: 'BPC-157',
    price_per_mg: 1.23,
    twap_members: 8,
    vendor_count: 12,
    range_24h: [1.18, 1.28],
    last_commit_sig: 'tBC5Y6f96Zdjc',
    last_slot: 420362835,
    ipfs_cid: 'bafkreih…kunhi',
    peg_state_pda: 'BPC157Pg3xKm…WvB2nG',
    vendors: [
      { name: 'GENETIC',     price: 1.22, in_twap: true },
      { name: 'PURE HEALTH', price: 1.25, in_twap: true },
      { name: 'SWISS CHEMS', price: 1.20, in_twap: true },
      { name: 'LIBERTY',     price: 1.24, in_twap: true },
      { name: 'NUSCIENCE',   price: 1.21, in_twap: true },
      { name: 'VERIFIED',    price: 1.26, in_twap: true },
      { name: 'PULSE',       price: 1.23, in_twap: true },
      { name: 'PURE RAWZ',   price: 1.24, in_twap: true },
      { name: 'PANDA',       price: 1.18, in_twap: false },
      { name: 'PURE TESTED', price: 1.28, in_twap: false },
      { name: 'EZ PEPTIDES', price: 1.19, in_twap: false },
      { name: 'OPTIMAL',     price: 1.27, in_twap: false },
    ],
  },
  ghkcu: {
    code: 'GHK-CU',
    price_per_mg: 0.938864,
    twap_members: 7,
    vendor_count: 11,
    range_24h: [0.91, 0.96],
    last_commit_sig: 'qK2Lf8m44Hxpz',
    last_slot: 420362821,
    ipfs_cid: 'bafkreif…rasm',
    peg_state_pda: null,
    vendors: [],
  },
};

export const MOCK_VERIFY = {
  cycle_id: 2005,
  twap_commit_slot: 420362835,
  twap_commit_sig: 'tBC5Y6f96Zdjc',
  components_hash_chain: '5f3d35b3…77283942',
  components_hash_ipfs: '5f3d35b3…77283942',
  peptides_finalized: 29,
  peptides_expected: 29,
  oracle_signature_valid: true,
  verify_ms: 412,
};

// COHORT — top movers and price distribution
export const MOCK_COHORT = {
  size: 29,
  movers_24h: {
    up: [
      { code: 'RETATRUTIDE',    change_pct:  4.2,  price:   89.30 },
      { code: 'TIRZEPATIDE',    change_pct:  2.8,  price:  124.50 },
      { code: 'SEMAGLUTIDE',    change_pct:  1.9,  price:  156.20 },
    ],
    down: [
      { code: 'MOTS-C',         change_pct: -3.2,  price:   18.90 },
      { code: 'KISSPEPTIN-10',  change_pct: -3.8,  price:   42.10 },
      { code: 'EPITHALON',      change_pct: -5.1,  price:    0.45 },
    ],
  },
  price_distribution: [
    { bucket: '>  $50 /mg',     count: 7  },
    { bucket: '$10 - $50 /mg',  count: 10 },
    { bucket: '$1 - $10 /mg',   count: 8  },
    { bucket: '<  $1 /mg',      count: 4  },
  ],
};

// MARKET - full tracked-peptide view current as of 2026-05-17.
// 30 priced + 16 in 7-day observation = 46 total.
// status='PRICED'  → live TWAP, contributes to per-peptide pricing
// status='OBS_7D'  → scraped, observations recorded, excluded from TWAP
//                    until quality-review window closes
// Source values match biohash.network/market; video script depends on
// these exact figures.
export const MOCK_MARKET = [
  // PRICED - sorted by price_per_mg descending.
  { code: 'TESO',         display_name: 'Tesofensine',                       price_per_mg: 380.0000, vendor_count: 2,  status: 'PRICED', range_24h: [360.00, 400.00] },
  { code: 'FOLLISTATIN',  display_name: 'Follistatin-344',                   price_per_mg: 139.9900, vendor_count: 3,  status: 'PRICED', range_24h: [99.00,  175.00] },
  { code: 'IGF1LR3',      display_name: 'IGF-1 LR3',                         price_per_mg: 62.4800,  vendor_count: 6,  status: 'PRICED', range_24h: [44.99,  200.00] },
  { code: 'CAGRILINTIDE', display_name: 'Cagrilintide',                      price_per_mg: 18.0000,  vendor_count: 3,  status: 'PRICED', range_24h: [14.40,  24.40]  },
  { code: 'GLP1',         display_name: 'Semaglutide / GLP-1 RA',            price_per_mg: 13.9157,  vendor_count: 4,  status: 'PRICED', range_24h: [10.00,  36.00]  },
  { code: 'LL37',         display_name: 'LL-37',                             price_per_mg: 13.8000,  vendor_count: 5,  status: 'PRICED', range_24h: [11.80,  20.00]  },
  { code: 'HUMANIN',      display_name: 'Humanin',                           price_per_mg: 13.1000,  vendor_count: 2,  status: 'PRICED', range_24h: [10.20,  16.00]  },
  { code: 'SERMORELIN',   display_name: 'Sermorelin',                        price_per_mg: 10.8875,  vendor_count: 6,  status: 'PRICED', range_24h: [7.20,   18.00]  },
  { code: 'HEXARELIN',    display_name: 'Hexarelin',                         price_per_mg: 9.9950,   vendor_count: 5,  status: 'PRICED', range_24h: [6.80,   12.00]  },
  { code: 'RETATRUTIDE',  display_name: 'Retatrutide',                       price_per_mg: 9.8980,   vendor_count: 3,  status: 'PRICED', range_24h: [8.98,   29.99]  },
  { code: 'AOD9604',      display_name: 'AOD-9604',                          price_per_mg: 9.7000,   vendor_count: 6,  status: 'PRICED', range_24h: [7.50,   19.00]  },
  { code: 'TESAMORELIN',  display_name: 'Tesamorelin',                       price_per_mg: 9.5000,   vendor_count: 9,  status: 'PRICED', range_24h: [6.50,   17.50]  },
  { code: 'TB500',        display_name: 'TB-500',                            price_per_mg: 8.4584,   vendor_count: 8,  status: 'PRICED', range_24h: [4.80,   21.00]  },
  { code: 'TA1',          display_name: 'Thymosin α-1',                      price_per_mg: 8.2000,   vendor_count: 9,  status: 'PRICED', range_24h: [5.80,   13.00]  },
  { code: 'CJC1295',      display_name: 'CJC-1295 (No-DAC / Mod GRF 1-29)',  price_per_mg: 7.8000,   vendor_count: 5,  status: 'PRICED', range_24h: [6.80,   11.00]  },
  { code: 'IPAMO',        display_name: 'Ipamorelin',                        price_per_mg: 7.5990,   vendor_count: 6,  status: 'PRICED', range_24h: [5.00,   15.00]  },
  { code: 'DSIP',         display_name: 'DSIP',                              price_per_mg: 6.9871,   vendor_count: 7,  status: 'PRICED', range_24h: [3.40,   12.47]  },
  { code: 'BPC157',       display_name: 'BPC-157',                           price_per_mg: 6.6990,   vendor_count: 8,  status: 'PRICED', range_24h: [3.63,   12.00]  },
  { code: 'KISSPEPTIN',   display_name: 'Kisspeptin-10',                     price_per_mg: 6.0000,   vendor_count: 7,  status: 'PRICED', range_24h: [3.80,   13.00]  },
  { code: 'SS31',         display_name: 'SS-31',                             price_per_mg: 6.0000,   vendor_count: 3,  status: 'PRICED', range_24h: [3.63,   8.39]   },
  { code: 'MOTSC',        display_name: 'MOTS-c',                            price_per_mg: 5.4000,   vendor_count: 11, status: 'PRICED', range_24h: [3.70,   11.00]  },
  { code: 'SELANK',       display_name: 'Selank',                            price_per_mg: 4.4990,   vendor_count: 7,  status: 'PRICED', range_24h: [3.49,   5.50]   },
  { code: 'PT141',        display_name: 'PT-141',                            price_per_mg: 4.4792,   vendor_count: 8,  status: 'PRICED', range_24h: [3.30,   8.00]   },
  { code: 'MT2',          display_name: 'Melanotan-II',                      price_per_mg: 3.9000,   vendor_count: 7,  status: 'PRICED', range_24h: [3.50,   9.75]   },
  { code: 'AMINO1MQ',     display_name: '5-Amino-1MQ',                       price_per_mg: 3.8000,   vendor_count: 5,  status: 'PRICED', range_24h: [1.98,   16.25]  },
  { code: 'EPITHAL',      display_name: 'Epitalon',                          price_per_mg: 3.5500,   vendor_count: 4,  status: 'PRICED', range_24h: [2.32,   6.50]   },
  { code: 'SEMAX',        display_name: 'Semax',                             price_per_mg: 3.4935,   vendor_count: 7,  status: 'PRICED', range_24h: [1.87,   9.00]   },
  { code: 'GHKCU',        display_name: 'GHK-Cu',                            price_per_mg: 0.8000,   vendor_count: 8,  status: 'PRICED', range_24h: [0.50,   6.89]   },
  { code: 'NAD',          display_name: 'NAD+',                              price_per_mg: 0.1190,   vendor_count: 7,  status: 'PRICED', range_24h: [0.07,   0.48]   },
  { code: 'GLUTATHIONE',  display_name: 'Glutathione',                       price_per_mg: 0.0683,   vendor_count: 5,  status: 'PRICED', range_24h: [0.05,   0.25]   },

  // OBS_7D - sorted by vendor_count descending. price_per_mg null.
  { code: 'KPV',          display_name: 'KPV',                               price_per_mg: null, vendor_count: 7, status: 'OBS_7D', range_24h: [4.00,  27.99] },
  { code: 'OXYTOCIN',     display_name: 'Oxytocin',                          price_per_mg: null, vendor_count: 7, status: 'OBS_7D', range_24h: [3.50,  13.00] },
  { code: 'CJC1295DAC',   display_name: 'CJC-1295 (with DAC)',               price_per_mg: null, vendor_count: 7, status: 'OBS_7D', range_24h: [7.00,  23.98] },
  { code: 'PINEALON',     display_name: 'Pinealon',                          price_per_mg: null, vendor_count: 6, status: 'OBS_7D', range_24h: [2.75,  6.00]  },
  { code: 'ARA290',       display_name: 'ARA-290',                           price_per_mg: null, vendor_count: 6, status: 'OBS_7D', range_24h: [4.00,  53.50] },
  { code: 'VIP',          display_name: 'VIP',                               price_per_mg: null, vendor_count: 5, status: 'OBS_7D', range_24h: [5.80,  14.60] },
  { code: 'GHRP6',        display_name: 'GHRP-6',                            price_per_mg: null, vendor_count: 4, status: 'OBS_7D', range_24h: [3.99,  6.80]  },
  { code: 'ADIPOTIDE',    display_name: 'Adipotide',                         price_per_mg: null, vendor_count: 4, status: 'OBS_7D', range_24h: [8.40,  17.80] },
  { code: 'GONADORELIN',  display_name: 'Gonadorelin',                       price_per_mg: null, vendor_count: 4, status: 'OBS_7D', range_24h: [6.40,  12.47] },
  { code: 'TIRZEPATIDE',  display_name: 'Tirzepatide',                       price_per_mg: null, vendor_count: 3, status: 'OBS_7D', range_24h: [11.90, 31.00] },
  { code: 'SURVODUTIDE',  display_name: 'Survodutide',                       price_per_mg: null, vendor_count: 3, status: 'OBS_7D', range_24h: [7.80,  20.00] },
  { code: 'GHRP2',        display_name: 'GHRP-2',                            price_per_mg: null, vendor_count: 3, status: 'OBS_7D', range_24h: [3.73,  4.00]  },
  { code: 'MGF',          display_name: 'MGF',                               price_per_mg: null, vendor_count: 3, status: 'OBS_7D', range_24h: [9.00,  24.00] },
  { code: 'PEGMGF',       display_name: 'PEG-MGF',                           price_per_mg: null, vendor_count: 3, status: 'OBS_7D', range_24h: [17.00, 25.00] },
  { code: 'DIHEXA',       display_name: 'Dihexa',                            price_per_mg: null, vendor_count: 3, status: 'OBS_7D', range_24h: [14.00, 20.00] },
  { code: 'MK677',        display_name: 'MK-677',                            price_per_mg: null, vendor_count: 3, status: 'OBS_7D', range_24h: [5.76,  10.00] },
];

// Pool of mock observations for the `watch` stream.
// Each entry: { vendor, peptide, price }
// Stream picks randomly and timestamps live.
export const MOCK_OBSERVATIONS_POOL = [
  { vendor: 'GENETIC',     peptide: 'BPC-157',        price: 1.22 },
  { vendor: 'GENETIC',     peptide: 'TB-500',         price: 3.45 },
  { vendor: 'GENETIC',     peptide: 'CJC-1295',       price: 2.18 },
  { vendor: 'GENETIC',     peptide: 'IGF-1 LR3',      price: 62.40 },
  { vendor: 'GENETIC',     peptide: 'GHK-CU',         price: 0.94 },
  { vendor: 'PURE HEALTH', peptide: 'BPC-157',        price: 1.25 },
  { vendor: 'PURE HEALTH', peptide: 'SEMAGLUTIDE',    price: 156.20 },
  { vendor: 'PURE HEALTH', peptide: 'TIRZEPATIDE',    price: 124.50 },
  { vendor: 'PURE HEALTH', peptide: 'MOTS-C',         price: 18.90 },
  { vendor: 'SWISS CHEMS', peptide: 'BPC-157',        price: 1.20 },
  { vendor: 'SWISS CHEMS', peptide: 'RETATRUTIDE',    price: 89.30 },
  { vendor: 'SWISS CHEMS', peptide: 'SELANK',         price: 0.78 },
  { vendor: 'SWISS CHEMS', peptide: 'EPITHALON',      price: 0.45 },
  { vendor: 'LIBERTY',     peptide: 'BPC-157',        price: 1.24 },
  { vendor: 'LIBERTY',     peptide: 'TB-500',         price: 3.40 },
  { vendor: 'LIBERTY',     peptide: 'MELANOTAN-2',    price: 4.10 },
  { vendor: 'LIBERTY',     peptide: 'KISSPEPTIN-10',  price: 42.10 },
  { vendor: 'NUSCIENCE',   peptide: 'IGF-1 LR3',      price: 62.20 },
  { vendor: 'NUSCIENCE',   peptide: 'CJC-1295',       price: 2.20 },
  { vendor: 'NUSCIENCE',   peptide: 'AOD-9604',       price: 5.80 },
  { vendor: 'VERIFIED',    peptide: 'BPC-157',        price: 1.26 },
  { vendor: 'VERIFIED',    peptide: 'TIRZEPATIDE',    price: 124.40 },
  { vendor: 'VERIFIED',    peptide: 'SEMAGLUTIDE',    price: 156.10 },
  { vendor: 'PULSE',       peptide: 'BPC-157',        price: 1.23 },
  { vendor: 'PULSE',       peptide: 'GHK-CU',         price: 0.95 },
  { vendor: 'PULSE',       peptide: 'TESAMORELIN',    price: 28.40 },
  { vendor: 'PURE RAWZ',   peptide: 'BPC-157',        price: 1.24 },
  { vendor: 'PURE RAWZ',   peptide: 'EPITHALON',      price: 0.46 },
  { vendor: 'PURE RAWZ',   peptide: 'MOTS-C',         price: 18.80 },
];
