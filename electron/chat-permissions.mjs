/** Per-chat Codex policy. These are native app-server settings, not prompt hints. */
export const PERMISSION_MODES = Object.freeze(['full', 'ask', 'auto']);
export function permissionMode(value) {
  if (value === undefined || value === null) return 'full';
  if (!PERMISSION_MODES.includes(value)) throw new Error('Choose a supported chat permission mode.');
  return value;
}
export function chatPermissionOptions(value) {
  const mode = permissionMode(value);
  return mode === 'full'
    ? { sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user' }
    : { sandbox: 'read-only', sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user' };
}
