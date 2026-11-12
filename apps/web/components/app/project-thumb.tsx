import { Screenshot } from './screenshot';

/** A project's live site as the browser check saw it, or a quiet placeholder until it's live. */
export function ProjectThumb({
  url,
  name,
  className = 'h-12 w-20',
}: {
  url: string | null | undefined;
  name: string;
  className?: string;
}) {
  return (
    <span
      className={`block shrink-0 overflow-hidden rounded border border-line bg-raised ${className}`}
    >
      {url ? (
        <Screenshot
          url={url}
          alt={`${name}, live`}
          className="h-full w-full"
          imgClassName="h-full w-full object-cover object-top"
        />
      ) : (
        <span
          aria-hidden
          className="grid h-full place-items-center font-mono text-[13px] uppercase text-muted/50"
        >
          {name.slice(0, 1)}
        </span>
      )}
    </span>
  );
}
