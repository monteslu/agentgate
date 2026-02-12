// Ink TUI helper utilities
// Replaces the old enquirer-based helpers

/**
 * handleCancel - kept for backward compatibility in case any code references it.
 * In the ink version, cancellation is handled via useInput 'q'/escape.
 */
export function handleCancel(err) {
  if (err === '' || err?.message === '' || err?.code === 'ERR_USE_AFTER_CLOSE') {
    return true;
  }
  return false;
}
