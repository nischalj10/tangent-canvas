import React, { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PAGE_VISUALIZATION_MEASURE, PAGE_VISUALIZATION_TOKEN_PREFIX, pageVisualizationSource, readPageVisualizationHeight } from '../electron/page-visualization-height.mjs';
import './page-visualization.css';

// The iframe remains opaque. Only bounded size messages from this exact window
// and this navigation's random token affect its layout; no app bridge enters it.
const PageVisualization = forwardRef(function PageVisualization({ src, title = 'Original Page visualization', className = '', onLoad, onHeight, style, loading = 'lazy' }, ref) {
  const frame = useRef(null);
  const loaded = useRef(false);
  const token = useMemo(() => globalThis.crypto.randomUUID(), [src]);
  const [size, setSize] = useState({ height: 240, limited: false });
  const currentSize = useRef(size);
  const heightCallback = useRef(onHeight);
  heightCallback.current = onHeight;
  useImperativeHandle(ref, () => frame.current, [src]);
  const requestMeasure = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: PAGE_VISUALIZATION_MEASURE, token }, '*');
  }, [token]);
  useLayoutEffect(() => {
    loaded.current = false;
    currentSize.current = { height: 240, limited: false };
    setSize(currentSize.current);
    const receive = event => {
      if (!loaded.current) return;
      const measured = readPageVisualizationHeight(event, frame.current?.contentWindow, token);
      if (!measured) return;
      const previous = currentSize.current;
      if (Math.abs(previous.height - measured.height) <= 1 && previous.limited === measured.limited) return;
      currentSize.current = measured;
      setSize(measured);
      heightCallback.current?.(measured);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [token, requestMeasure]);
  if (!pageVisualizationSource(src)) return null;
  return <iframe
    ref={frame}
    src={src}
    name={`${PAGE_VISUALIZATION_TOKEN_PREFIX}${token}`}
    sandbox="allow-scripts"
    referrerPolicy="no-referrer"
    title={title}
    loading={loading}
    className={`page-visualization-frame nodrag nopan nowheel ${className}`.trim()}
    data-testid="page-visualization-frame"
    data-visualization-height={size.height}
    data-visualization-limited={String(size.limited)}
    style={{ ...style, height: `${size.height}px` }}
    onLoad={event => { loaded.current = true; requestMeasure(); onLoad?.(event); }}
  />;
});
export { PageVisualization };
export default PageVisualization;
