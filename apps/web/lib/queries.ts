'use client';

import type {
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
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { api, setCsrfToken } from './api';

type T<S extends z.ZodType> = z.infer<S>;
export type MeT = T<typeof Me>;
export type ProjectT = T<typeof Project>;
export type DeploymentT = T<typeof Deployment>;
export type DeploymentSummaryT = T<typeof DeploymentSummary>;
export type RepairT = T<typeof Repair> & { projectSlug?: string; deploymentNumber?: number };
export type Page<X> = { items: X[]; nextCursor: string | null };

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

export const useProjects = () =>
  useQuery({
    queryKey: ['projects'],
    queryFn: () => api<Page<ProjectT>>('/api/v1/projects?limit=100'),
  });
export const useProject = (id: string) =>
  useQuery({ queryKey: ['project', id], queryFn: () => api<ProjectT>(`/api/v1/projects/${id}`) });

export function useDeployments(
  params: { projectId?: string; status?: string; limit?: number } = {},
  refetchMs?: number,
) {
  const qs = new URLSearchParams(
    Object.entries({
      limit: String(params.limit ?? 30),
      ...(params.projectId && { projectId: params.projectId }),
      ...(params.status && { status: params.status }),
    }),
  );
  return useQuery({
    queryKey: ['deployments', params],
    queryFn: () => api<Page<DeploymentSummaryT>>(`/api/v1/deployments?${qs}`),
    ...(refetchMs && { refetchInterval: refetchMs }),
  });
}

export const useDeployment = (id: string) =>
  useQuery({
    queryKey: ['deployment', id],
    queryFn: () => api<DeploymentT>(`/api/v1/deployments/${id}`),
  });
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
    queryFn: () => api<{ enabled: boolean; recoveryCodesLeft: number }>('/api/v1/me/2fa'),
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
