export const ROUNDUP_PAYMENTS = [
  { id: 'coffee', name: 'Coffee', cents: 340, saved: 60, image: '/artwork/movy_everyday_coffee.webp', moment: 'A morning ritual' },
  { id: 'groceries', name: 'Groceries', cents: 3820, saved: 80, image: '/artwork/movy_everyday_groceries.webp', moment: 'Something for the week' },
  { id: 'commute', name: 'Commute', cents: 275, saved: 25, image: '/artwork/movy_everyday_commute.webp', moment: 'On your way' },
  { id: 'lunch', name: 'Lunch', cents: 1425, saved: 75, image: '/artwork/movy_everyday_lunch.webp', moment: 'A pause in the day' },
] as const

export function formatCents(cents: number) { return `$${(cents / 100).toFixed(2)}` }
export function roundedBasis(cents: number) { return Math.ceil(cents / 100) * 100 }
export const accumulatedCents = ROUNDUP_PAYMENTS.map((_, index) =>
  ROUNDUP_PAYMENTS.slice(0, index + 1).reduce((sum, payment) => sum + payment.saved, 0))
