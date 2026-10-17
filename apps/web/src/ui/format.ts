/** Formats integer cents as dollars with thousands separators and two decimals: `$10,000.00`. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = (abs % 100).toString().padStart(2, "0");
  return `${sign}$${dollars}.${rest}`;
}

/**
 * A change in money, as a sign and a figure: `+$640.00` for a gain, `−$120.00` for a loss (with a
 * true minus sign, which lines up with the plus), `$0.00` for none.
 */
export function formatChange(cents: number): string {
  if (Math.round(cents) === 0) return formatCents(0);
  return cents > 0 ? `+${formatCents(cents)}` : `\u2212${formatCents(-cents)}`;
}
