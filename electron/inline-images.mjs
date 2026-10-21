/** Native image outputs are transcript items, never a gallery after a whole chat. */
export function imageMessage(item, turnId, asset, createdAt = Date.now()) {
  return {
    id: item.id, role: 'assistant', kind: 'imageGeneration', text: '',
    turnId, createdAt, status: 'completed',
    images: [{ ...asset, itemId: item.id, turnId,
      alt: item.revisedPrompt || 'Generated image', createdAt }],
  };
}

/** Keep a late output inside its native turn, ahead of a later queued question. */
export function insertTurnMessage(messages, message, { beforeId, afterId } = {}) {
  const existing = messages.findIndex(candidate => candidate.id === message.id);
  if (existing >= 0) return messages[existing];
  let index = beforeId ? messages.findIndex(candidate => candidate.id === beforeId) : -1;
  if (index < 0 && afterId) {
    const after = messages.findIndex(candidate => candidate.id === afterId);
    if (after >= 0) index = after + 1;
  }
  if (index < 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].turnId === message.turnId) { index = i + 1; break; }
    }
  }
  messages.splice(index < 0 ? messages.length : index, 0, message);
  return message;
}

/** Match legacy assets by verified bytes; asset identity alone cannot infer a turn. */
export function bindImageMessage(node, item, turnId, asset, options = {}) {
  if (!turnId || !item?.id || !asset?.id) return false;
  node.generatedImages ??= [];
  const existing = node.generatedImages.find(image => image.itemId === item.id && image.turnId === turnId);
  const legacy = node.generatedImages.find(image => image.id === asset.id && !image.itemId && !image.turnId);
  const message = imageMessage(item, turnId, asset, options.createdAt ?? legacy?.createdAt ?? Date.now());
  if (existing) Object.assign(existing, message.images[0]);
  else if (legacy) Object.assign(legacy, message.images[0]);
  else node.generatedImages.push(message.images[0]);
  const previous = node.messages.find(candidate => candidate.id === item.id);
  if (previous) {
    if (previous.kind !== 'imageGeneration') return false;
    // Replayed receipts refresh only their own image, never append a second item.
    previous.images = message.images;
    previous.turnId = turnId;
  } else insertTurnMessage(node.messages, message, options);
  return true;
}

/** Reconcile only byte-matched legacy images against authoritative native history. */
export function repairImageBindings(node, thread, assets) {
  let repaired = 0;
  const inheritedTurns = new Set(node.messages.slice(0, node.inheritedCount || 0).map(message => message.turnId));
  const receipts = [];
  for (const turn of thread?.turns || []) {
    const items = turn.items || [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (item.type !== 'imageGeneration' || item.status === 'failed' || item.failure) continue;
      let asset;
      try { asset = assets.fromGeneration(item); } catch { continue; }
      if (asset) receipts.push({ turn, items, index, item, asset });
    }
  }
  for (const { turn, items, index, item, asset } of receipts) {
      const candidates = node.generatedImages?.filter(image => image.id === asset.id &&
        (!image.itemId || image.itemId === item.id) && (!image.turnId || image.turnId === turn.id)) || [];
      if (!candidates.length) continue;
      // A legacy content hash that occurs in multiple turns has no unique owner.
      // Preserve it until native item/turn metadata can disambiguate it.
      if (!candidates.some(image => image.itemId === item.id && image.turnId === turn.id) &&
        receipts.filter(receipt => receipt.asset.id === asset.id).length !== 1) continue;
      if (node.messages.some(message => message.id === item.id && message.kind === 'imageGeneration')) continue;
      const afterId = [...items.slice(0, index)].reverse().find(candidate => node.messages.some(message => message.id === candidate.id))?.id;
      const beforeId = items.slice(index + 1).find(candidate => node.messages.some(message => message.id === candidate.id))?.id;
      if (bindImageMessage(node, item, turn.id, asset, { beforeId, afterId })) {
        repaired++;
        if (inheritedTurns.has(turn.id)) node.inheritedCount++;
      }
  }
  return repaired;
}
