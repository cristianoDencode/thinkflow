import type { TestBBox } from '@thinkflow/shared';
import { cn } from '../../lib/utils';

/** Automatic screenshot of a step, with the element it acted on highlighted. */
export function StepThumbnail({
  src,
  bbox,
  alt,
  className,
}: {
  src: string;
  bbox: TestBBox | null;
  alt: string;
  className?: string;
}) {
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      className={cn('relative block overflow-hidden rounded-lg border border-border', className)}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className="block h-full w-full object-cover object-top"
      />
      {bbox && bbox.w > 0 && bbox.h > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute rounded-sm border-2 border-danger"
          style={{
            left: `${bbox.x * 100}%`,
            top: `${bbox.y * 100}%`,
            width: `${bbox.w * 100}%`,
            height: `${bbox.h * 100}%`,
          }}
        />
      )}
    </a>
  );
}
