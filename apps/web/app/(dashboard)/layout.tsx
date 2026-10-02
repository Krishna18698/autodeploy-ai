import type { ReactNode } from 'react';
import { Providers } from '@/components/app/providers';
import { Shell } from '@/components/app/shell';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <Providers>
      <Shell>{children}</Shell>
    </Providers>
  );
}
