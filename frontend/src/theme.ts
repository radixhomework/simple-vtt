/**
 * Canvas color constants — the drawing-side half of the parchment & ink
 * palette defined as CSS variables in index.html. Canvas rendering cannot
 * read CSS custom properties, so keep the two lists in sync.
 */
export const PALETTE = {
  ink: '#1E211C',       // root black — fog, dark fills, labels
  parchment: '#D8D0BD', // light text on dark fills
  moss: '#4D5947',      // brand — default token color, open portals
  earth: '#76604E',     // secondary — walls, cone tool
  copper: '#9A7656',    // accent — selection, measurements, closed portals
  rose: '#8A5E61',      // special — circle tool
} as const
