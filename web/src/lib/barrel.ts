/**
 * Merrain's mark, a barrel drawn in staves: one drawing for the site's marks and for the chat's, whose staves
 * light in turn while the assistant thinks. The view box is the drawing's own extent, so its ink fills the box.
 */
export const BARREL = {
  viewBox: '0 4 64 72',
  /** From left to right, the order they light in. */
  staves: ['M15 4C5 28 5 52 15 76', 'M24 4C19 28 19 52 24 76', 'M32 4V76', 'M40 4C45 28 45 52 40 76', 'M49 4C59 28 59 52 49 76'],
  hoops: 'M12 22H52M12 58H52',
} as const;
