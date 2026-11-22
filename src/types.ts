export const ROLES = ['customer', 'vendor', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const CATEGORIES = [
  'Photography & Videography',
  'Wedding Venues',
  'Decoration & Florist',
  'Catering Services',
  'Makeup & Styling',
  'Wedding Fashion',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SERVICE_STATUSES = ['Pending', 'Approved', 'Rejected'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const BOOKING_STATUSES = ['Pending', 'Accepted', 'Rejected', 'Cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const TX_STATUSES = ['Pending', 'Succeeded', 'Failed'] as const;
export type TxStatus = (typeof TX_STATUSES)[number];

export type Plan = 'Free' | 'Premium';
export const FREE_PLAN_ACTIVE_LIMIT = 3;
