// Feature flags and small runtime policies for UX behaviors
// - Toggle suggested unread counting: timestamp vs per-item flag
// - Control pulse animation re-run policy (once / version / daily)

// If true, compute Suggested tab unread by "per-item flag (readAt == null)".
// If false, compute by "createdAt > suggestedLastOpenedAt" timestamp.
export const SUGGESTED_UNREAD_BY_FLAG = true;

// Pulse animation policies per tab. You can change these values anytime.
// type: 'once' | 'version' | 'daily'
// - 'version': re-run when version string changes
// - 'daily': re-run once per calendar day (device local time)
export const PULSE_POLICY = {
  article: { type: 'version', version: '2025-08-29' },
  suggested: { type: 'daily' },
};

