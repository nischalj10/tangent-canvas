// Keep native menu accelerators and keyboard input on the same zoom route.
// Electron's before-input-event prevents both DOM input and menu shortcuts
// when handled, so a single press cannot zoom twice.
export function zoomActionForInput(input, platform = process.platform) {
  if (input?.type !== 'keyDown' || input.alt || !(platform === 'darwin' ? input.meta : input.control)) return null;
  const key = input.key, code = input.code;
  if (key === '+' || key === '=' || key === 'Add' || code === 'Equal' || code === 'NumpadAdd') return 'zoom-in';
  if (key === '-' || key === '_' || key === 'Subtract' || code === 'Minus' || code === 'NumpadSubtract') return 'zoom-out';
  if ((key === '0' || code === 'Digit0' || code === 'Numpad0') && !input.shift) return 'zoom-reset';
  return null;
}
