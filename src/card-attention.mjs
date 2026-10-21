export const cardAttention = node =>
  ['starting','running','awaiting-approval'].includes(node.status) ? 'working'
    : node.hasUnreadReply ? 'completed' : undefined;

export const cardAttentionDescription = node =>
  cardAttention(node)==='working' ? 'Codex is still working on this conversation.'
    : node.hasUnreadReply ? 'New answer completed. Click this card to mark it read.' : undefined;
