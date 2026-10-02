'use client';

import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useProjects } from '@/lib/queries';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const projects = useProjects();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      overlayClassName="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
      contentClassName="fixed left-1/2 top-[18vh] z-50 w-[min(92vw,560px)] -translate-x-1/2 overflow-hidden rounded-[10px] border border-line bg-panel shadow-2xl"
    >
      <Command.Input
        placeholder="Jump to a project, page or action…"
        className="h-12 w-full border-b border-line bg-transparent px-4 text-[14px] text-fg outline-none placeholder:text-muted/70"
      />
      <Command.List className="max-h-[50vh] overflow-y-auto p-2 text-[13px]">
        <Command.Empty className="px-3 py-6 text-center text-muted">No results.</Command.Empty>
        <Command.Group
          heading="Navigate"
          className="px-1 py-1 font-mono text-[10px] uppercase tracking-wider text-muted [&_[cmdk-group-items]]:mt-1"
        >
          {[
            ['Overview', '/overview'],
            ['Projects', '/projects'],
            ['New project', '/projects/new'],
            ['Deployments', '/deployments'],
            ['Recovery center', '/recovery'],
            ['Analytics', '/analytics'],
            ['Settings', '/settings'],
          ].map(([label, href]) => (
            <Command.Item
              key={href}
              onSelect={() => go(href as string)}
              className="cursor-pointer rounded px-3 py-2 font-sans text-[13px] normal-case tracking-normal text-fg data-[selected=true]:bg-raised"
            >
              {label}
            </Command.Item>
          ))}
        </Command.Group>
        {projects.data?.items.length ? (
          <Command.Group
            heading="Projects"
            className="px-1 py-1 font-mono text-[10px] uppercase tracking-wider text-muted [&_[cmdk-group-items]]:mt-1"
          >
            {projects.data.items.map((p) => (
              <Command.Item
                key={p.id}
                value={`project ${p.slug} ${p.repoFullName}`}
                onSelect={() => go(`/projects/${p.id}`)}
                className="flex cursor-pointer items-center justify-between rounded px-3 py-2 font-sans text-[13px] normal-case tracking-normal text-fg data-[selected=true]:bg-raised"
              >
                <span>{p.slug}</span>
                <span className="font-mono text-[11px] text-muted">{p.repoFullName}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
    </Command.Dialog>
  );
}
