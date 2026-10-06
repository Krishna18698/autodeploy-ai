export function formatPrice(cents: number): string {
  const amount: string = cents / 100;
  return `$${amount}`;
}
