'use client';

import { useEffect, useRef, useState } from 'react';
import { WaveDots } from '@/components/ui/loaders';
import { apiAsset } from '@/lib/api';

/**
 * A deployment's screenshot (an authenticated API image): wave dots until it
 * arrives, then the picture. A missing one leaves the empty frame.
 */
export function Screenshot({
  url,
  alt,
  className = '',
  imgClassName = '',
  dot = 4,
}: {
  url: string;
  alt: string;
  className?: string;
  imgClassName?: string;
  dot?: number;
}) {
  const [state, setState] = useState<'loading' | 'shown' | 'missing'>('loading');
  const img = useRef<HTMLImageElement>(null);
  // Already in the browser's cache: it may have finished before React listened.
  useEffect(() => {
    if (img.current?.complete && img.current.naturalWidth > 0) setState('shown');
  }, []);
  return (
    <span className={`relative block ${className}`}>
      {state === 'loading' && (
        <span className="absolute inset-0 grid place-items-center">
          <WaveDots size={dot} />
        </span>
      )}
      {state !== 'missing' && (
        // biome-ignore lint/performance/noImgElement: authenticated API image, not optimisable by next/image
        <img
          ref={img}
          src={apiAsset(url)}
          alt={alt}
          loading="lazy"
          onLoad={() => setState('shown')}
          onError={() => setState('missing')}
          className={`${imgClassName} ${state === 'shown' ? '' : 'opacity-0'}`}
        />
      )}
    </span>
  );
}
