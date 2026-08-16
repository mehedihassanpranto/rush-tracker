/**
 * Low-remaining-balance alert threshold: flag accounts about to run out of
 * Meta budget, including ones already deeper into the red than this (lower
 * remaining is still low). Currency-native — Meta's spend_cap is
 * denominated in the account's own currency and this app has no FX
 * conversion path, same gate as the rest of the Meta integration.
 *
 * Shared between the ad accounts list (bell + "Current balance" column) and
 * the account detail page (Meta live data card) so the two stay in sync.
 */
export const LOW_BALANCE_THRESHOLD = 60
