'use client';

import type {
  AccessRequest,
  AdminSite,
  AnalyticsSummary,
  ApiToken,
  AuditEvent,
  Deployment,
  DeploymentEvent,
  DeploymentSummary,
  EnvVar,
  Invitation,
  Me,
  Member,
  PendingInvitation,
  Project,
  Quota,
  Repair,
  WebhookDelivery,
  WebhookEndpoint,
} from '@autodeploy/contracts';
import { type QueryClient, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { api, post, setCsrfToken } from './api';
import { STATUS } from './status';

type T<S extends z.ZodType> = z.infer<S>;
export type MeT = T<typeof Me>;
export type ProjectT = T<typeof Project>;
export type DeploymentT = T<typeof Deployment>;
export type DeploymentSummaryT = T<typeof DeploymentSummary>;
export type RepairT = T<typeof Repair> & { projectSlug?: string; deploymentNumber?: number };
export type Page<X> = { items: X[]; nextCursor: string | null };

const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;
/** Whether the signed-in role may take an action that needs `need` (the API checks again). */
export function useCan(need: 'member' | 'admin') {
  const role = useMe().data?.org.role;
  return role !== undefined && RANK[role] >= RANK[need];
}
/** Shown on an action the signed-in role can't take, such as a visitor's in the demo. */
export const READ_ONLY = 'Read-only: you can look around, not change things here';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const me = await api<MeT>('/api/v1/me');
      setCsrfToken(me.csrfToken);
      return me;
    },
    retry: false,
    staleTime: 60_000,
  });
}

/** The first page of projects (the overview, the command palette). */
export const useProjects = (enabled = true) =>
  useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => api<Page<ProjectT>>('/api/v1/projects?limit=100', { signal }),
    enabled,
  });
/** Every project, a page at a time (the Projects screen). */
export const useProjectPages = () =>
  useInfiniteQuery({
    queryKey: ['projects', 'pages'],
    queryFn: ({ pageParam, signal }) =>
      api<Page<ProjectT>>(
        `/api/v1/projects?limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
/** Projects whose name, address or repository contains `q` (the palette, past one page). */
export const useProjectSearch = (q: string, enabled: boolean) =>
  useQuery({
    queryKey: ['projects', 'search', q],
    queryFn: ({ signal }) =>
      api<Page<ProjectT>>(`/api/v1/projects?limit=20&q=${encodeURIComponent(q)}`, { signal }),
    enabled: enabled && q.length > 0,
    staleTime: 30_000,
  });
export const useProject = (id: string) =>
  useQuery({
    queryKey: ['project', id],
    queryFn: ({ signal }) => api<ProjectT>(`/api/v1/projects/${id}`, { signal }),
  });

/** Lists poll fast while something in them is in flight, and slowly once it's all settled. */
const FAST_MS = 4_000;
const IDLE_MS = 30_000;
const inFlight = (items: DeploymentSummaryT[] | undefined) =>
  items?.some((d) => STATUS[d.status]?.live || d.status === 'READY') ?? false;

function deploymentsQuery(params: { projectId?: string; status?: string; limit?: number }) {
  return new URLSearchParams(
    Object.entries({
      limit: String(params.limit ?? 30),
      ...(params.projectId && { projectId: params.projectId }),
      ...(params.status && { status: params.status }),
    }),
  );
}

/** The latest deployments; `live` keeps them current (fast while any is in flight). */
export function useDeployments(
  params: { projectId?: string; status?: string; limit?: number } = {},
  live = false,
) {
  const qs = deploymentsQuery(params);
  return useQuery({
    queryKey: ['deployments', params],
    queryFn: ({ signal }) => api<Page<DeploymentSummaryT>>(`/api/v1/deployments?${qs}`, { signal }),
    ...(live && {
      refetchInterval: (q: { state: { data?: Page<DeploymentSummaryT> } }) =>
        inFlight(q.state.data?.items) ? FAST_MS : IDLE_MS,
    }),
  });
}

/** Every deployment matching the filters, a page at a time, kept current like useDeployments. */
export function useDeploymentPages(params: {
  projectId?: string;
  status?: string;
  limit?: number;
}) {
  const qs = deploymentsQuery(params);
  return useInfiniteQuery({
    queryKey: ['deployments', params, 'pages'],
    queryFn: ({ pageParam, signal }) =>
      api<Page<DeploymentSummaryT>>(
        `/api/v1/deployments?${qs}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (q) =>
      inFlight(q.state.data?.pages.flatMap((p) => p.items)) ? FAST_MS : IDLE_MS,
  });
}

export const useDeployment = (id: string) =>
  useQuery({
    queryKey: ['deployment', id],
    queryFn: ({ signal }) => api<DeploymentT>(`/api/v1/deployments/${id}`, { signal }),
  });

/**
 * Switches the session to another org. Requests still answering for the old one
 * are called off first, and everything cached is dropped after, so nothing from
 * the previous org shows under the new one's name; pages refetch, the shell
 * showing the opening logo until the account is back.
 */
export async function switchOrg(qc: QueryClient, orgId: string) {
  await qc.cancelQueries();
  await post('/api/v1/session/org', { orgId });
  await qc.resetQueries();
}
export const useEvents = (id: string) =>
  useQuery({
    queryKey: ['events', id],
    queryFn: () => api<Array<T<typeof DeploymentEvent>>>(`/api/v1/deployments/${id}/events`),
  });
export const useRepairs = (deploymentId: string) =>
  useQuery({
    queryKey: ['repairs', deploymentId],
    queryFn: () => api<RepairT[]>(`/api/v1/deployments/${deploymentId}/repairs`),
  });
export const useAllRepairs = (status: 'awaiting_approval' | 'all' = 'all') =>
  useQuery({
    queryKey: ['all-repairs', status],
    queryFn: () => api<RepairT[]>(`/api/v1/repairs?status=${status}`),
    refetchInterval: 15_000,
  });
export const useAnalytics = (days: number) =>
  useQuery({
    queryKey: ['analytics', days],
    queryFn: () => api<T<typeof AnalyticsSummary>>(`/api/v1/analytics?days=${days}`),
    refetchInterval: 30_000,
  });
export const useQuota = () =>
  useQuery({ queryKey: ['quota'], queryFn: () => api<T<typeof Quota>>('/api/v1/quota') });
export const useEnv = (projectId: string) =>
  useQuery({
    queryKey: ['env', projectId],
    queryFn: () => api<Array<T<typeof EnvVar>>>(`/api/v1/projects/${projectId}/env`),
  });
export const useMembers = () =>
  useQuery({
    queryKey: ['members'],
    queryFn: () => api<Array<T<typeof Member>>>('/api/v1/members'),
  });
/** Whether the signed-in person has two-step sign-in on. */
export const useTwoFactor = () =>
  useQuery({
    queryKey: ['two-factor'],
    queryFn: () =>
      api<{ enabled: boolean; recoveryCodesLeft: number; trustedBrowsers: number }>(
        '/api/v1/me/2fa',
      ),
  });
/** Platform admins: sites matching a search, or every one taken down. */
export const useAdminSites = (q: string, down: boolean) =>
  useQuery({
    queryKey: ['admin-sites', q, down],
    queryFn: () =>
      api<Array<T<typeof AdminSite>>>(
        `/api/v1/admin/sites?${down ? 'state=down' : `q=${encodeURIComponent(q)}`}`,
      ),
    enabled: down || q.length > 0,
  });
/** Platform admins: accounts asking to deploy (portfolio mode), oldest first. */
export const useAccessRequests = (enabled: boolean) =>
  useQuery({
    queryKey: ['access-requests'],
    queryFn: () => api<Array<T<typeof AccessRequest>>>('/api/v1/admin/access-requests'),
    enabled,
  });
/** Admins: invitations this org has sent that nobody has answered yet. */
export const usePendingInvites = (enabled: boolean) =>
  useQuery({
    queryKey: ['invites', 'pending'],
    queryFn: () => api<Array<T<typeof PendingInvitation>>>('/api/v1/members/invitations'),
    enabled,
  });
/** Invitations waiting for the signed-in person. */
export const useMyInvitations = () =>
  useQuery({
    queryKey: ['invites', 'mine'],
    queryFn: () => api<Array<T<typeof Invitation>>>('/api/v1/invitations'),
  });
export const useTokens = () =>
  useQuery({
    queryKey: ['tokens'],
    queryFn: () => api<Array<T<typeof ApiToken>>>('/api/v1/tokens'),
  });
export const useWebhooks = () =>
  useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api<Array<T<typeof WebhookEndpoint>>>('/api/v1/webhooks'),
  });
export const useDeliveries = (id: string | null) =>
  useQuery({
    queryKey: ['deliveries', id],
    queryFn: () => api<Array<T<typeof WebhookDelivery>>>(`/api/v1/webhooks/${id}/deliveries`),
    enabled: Boolean(id),
    refetchInterval: 5_000,
  });
export const useAudit = () =>
  useQuery({
    queryKey: ['audit'],
    queryFn: () => api<Page<T<typeof AuditEvent>>>('/api/v1/audit?limit=50'),
  });

/** Building on the repository's own GitHub Actions: where the project stands (ADR 0010). */
export type ActionsSetupT = {
  state: 'unavailable' | 'missing' | 'outdated' | 'pr_open' | 'ready';
  branch: string;
  prUrl?: string;
};
export const useActionsSetup = (projectId: string) =>
  useQuery({
    queryKey: ['github-actions', projectId],
    queryFn: () => api<ActionsSetupT>(`/api/v1/projects/${projectId}/github-actions`),
    staleTime: 30_000,
  });

/** Which sign-in methods this server offers (Google needs its OAuth client configured). */
export const useProviders = () =>
  useQuery({
    queryKey: ['providers'],
    queryFn: () => api<{ google: boolean }>('/auth/providers'),
    staleTime: 3_600_000,
  });
