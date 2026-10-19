'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/app/shell';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { ApiError, del, patch, post } from '@/lib/api';
import { ago } from '@/lib/format';
import {
  useAudit,
  useDeliveries,
  useMe,
  useMembers,
  useQuota,
  useTokens,
  useWebhooks,
} from '@/lib/queries';

type TabId = 'team' | 'account' | 'usage' | 'tokens' | 'webhooks' | 'audit';
const EVENTS = [
  'deployment.created',
  'deployment.succeeded',
  'deployment.failed',
  'deployment.activated',
  'deployment.rolled_back',
  'repair.awaiting_approval',
];

export default function SettingsPage() {
  const [tab, setTab] = useState<TabId>('team');
  const me = useMe();
  const admin = me.data && ['owner', 'admin'].includes(me.data.org.role);
  return (
    <>
      <PageHeader
        title="Settings"
        sub={me.data ? `${me.data.org.name} · you are ${me.data.org.role}` : ''}
      />
      <Tabs
        id="settings"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'team', label: 'Team' },
          { id: 'account', label: 'Account' },
          { id: 'usage', label: 'Usage' },
          { id: 'tokens', label: 'API tokens' },
          ...(admin
            ? [
                { id: 'webhooks' as const, label: 'Webhooks' },
                { id: 'audit' as const, label: 'Audit log' },
              ]
            : []),
        ]}
      />
      <div className="mt-5">
        {tab === 'team' && <Team canEdit={Boolean(admin)} />}
        {tab === 'account' && (
          <div className="flex flex-col gap-5">
            <Notifications />
            <DeleteAccount />
          </div>
        )}
        {tab === 'usage' && <Usage />}
        {tab === 'tokens' && <Tokens />}
        {tab === 'webhooks' && <Webhooks />}
        {tab === 'audit' && <Audit />}
      </div>
    </>
  );
}

const input =
  'h-9 rounded-md border border-line bg-bg px-3 font-mono text-[13px] text-fg outline-none focus:border-run/60';

function Team({ canEdit }: { canEdit: boolean }) {
  const members = useMembers();
  const toast = useToast();
  const [login, setLogin] = useState('');
  const [role, setRole] = useState('member');
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post('/api/v1/members', { login, role });
      setLogin('');
      await members.refetch();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed', 'fail');
    }
  };
  const change = async (userId: string, r: string) => {
    try {
      await patch(`/api/v1/members/${userId}`, { role: r });
      await members.refetch();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed', 'fail');
    }
  };
  return (
    <Panel title="Members">
      {canEdit && (
        <form onSubmit={add} className="mb-4 flex flex-col gap-2 sm:flex-row">
          <input
            required
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="GitHub login"
            aria-label="GitHub login"
            className={`${input} flex-1`}
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            aria-label="Role"
            className={input}
          >
            <option value="viewer">viewer</option>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <Button type="submit" variant="primary">
            Add
          </Button>
        </form>
      )}
      <ul className="divide-y divide-line">
        {members.data?.map((m) => (
          <li key={m.userId} className="flex items-center gap-3 py-2.5 text-[13px]">
            <span
              aria-hidden
              className="grid size-7 place-items-center rounded-full border border-line bg-raised font-mono text-[11px]"
            >
              {m.login.slice(0, 2).toUpperCase()}
            </span>
            <span className="flex-1">
              {m.login} <span className="text-muted">{m.name}</span>
            </span>
            {canEdit ? (
              <select
                value={m.role}
                onChange={(e) => change(m.userId, e.target.value)}
                aria-label={`Role for ${m.login}`}
                className={input}
              >
                {['viewer', 'member', 'admin', 'owner'].map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            ) : (
              <span className="font-mono text-[12px] text-muted">{m.role}</span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Notifications() {
  const me = useMe();
  const toast = useToast();
  const [email, setEmail] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = me.data?.user.email ?? '';
  const value = email ?? current;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await patch('/api/v1/me', { email: value.trim() || null });
      await me.refetch();
      setEmail(null);
      toast(value.trim() ? `Notifications go to ${value.trim()}` : 'Email notifications off', 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save', 'fail');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel title="Email notifications">
      <p className="mb-3 text-[13px] text-muted">
        Failed deployments, missing environment variables and repairs waiting for your approval are
        emailed here. GitHub only shares public emails, so set it yourself; leave it empty to turn
        emails off.
      </p>
      <form onSubmit={save} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          value={value}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-label="Notification email"
          className={`${input} flex-1`}
        />
        <Button type="submit" variant="primary" loading={saving} disabled={value === current}>
          Save
        </Button>
      </form>
    </Panel>
  );
}

/** Deletes the account and every org it alone owns; typed confirmation, sessions only. */
function DeleteAccount() {
  const me = useMe();
  const toast = useToast();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const login = me.data?.user.login ?? '';
  const remove = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await del('/api/v1/me', { confirm });
      location.assign('/');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete the account', 'fail');
      setBusy(false);
    }
  };
  return (
    <Panel title="Delete account">
      <p className="mb-3 text-[13px] text-muted">
        Deletes your account and every organisation only you own: its projects, live sites,
        environment variables, API tokens and history. Stored builds and logs are removed within a
        day; encrypted backups age out within 4 weeks. This can't be undone. Uninstall the
        AutoDeploy GitHub App from your GitHub settings as well.
      </p>
      <form onSubmit={remove} className="flex flex-col gap-2 sm:flex-row">
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={login ? `type ${login} to confirm` : 'type your login to confirm'}
          aria-label="Type your login to confirm"
          className={`${input} flex-1`}
        />
        <Button
          type="submit"
          variant="danger"
          loading={busy}
          disabled={!login || confirm.trim().toLowerCase() !== login.toLowerCase()}
        >
          Delete my account
        </Button>
      </form>
    </Panel>
  );
}

/** What this account has used of its limits (free for everyone, so shared fairly). */
function Usage() {
  const q = useQuota();
  if (!q.data) return <Panel title="Usage">Loading…</Panel>;
  const u = q.data;
  const mb = (b: number) => `${(b / 1024 / 1024).toFixed(b < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  const rows: [string, number, number, string, string][] = [
    [
      'Deployments today',
      u.deploysToday,
      u.deploysPerDay,
      `${u.deploysToday}`,
      `${u.deploysPerDay}`,
    ],
    [
      'Build minutes this month',
      u.buildMinutesThisMonth,
      u.buildMinutesPerMonth,
      `${u.buildMinutesThisMonth}`,
      `${u.buildMinutesPerMonth}`,
    ],
    ['Projects', u.projects, u.projectLimit, `${u.projects}`, `${u.projectLimit}`],
    [
      'Server-rendered projects',
      u.serverProjects,
      u.serverProjectLimit,
      `${u.serverProjects}`,
      `${u.serverProjectLimit}`,
    ],
    ['Storage', u.storageBytes, u.storageLimitBytes, mb(u.storageBytes), mb(u.storageLimitBytes)],
  ];
  return (
    <Panel title="Usage">
      <p className="mb-4 text-[13px] text-muted">
        AutoDeploy is free for everyone, so each account gets a fair share. Deployments reset daily
        at 00:00 UTC and build minutes on the 1st of each month.
      </p>
      <ul className="flex flex-col gap-4">
        {rows.map(([label, used, limit, usedText, limitText]) => {
          const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
          return (
            <li key={label}>
              <div className="mb-1.5 flex justify-between text-[13px]">
                <span>{label}</span>
                <span className="font-mono text-muted">
                  {usedText} / {limitText}
                </span>
              </div>
              <div
                className="h-1.5 overflow-hidden rounded-full bg-raised"
                role="progressbar"
                aria-label={label}
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`h-full rounded-full ${pct >= 100 ? 'bg-fail' : pct >= 80 ? 'bg-warn' : 'bg-run'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function Tokens() {
  const tokens = useTokens();
  const toast = useToast();
  const [name, setName] = useState('');
  const [scope, setScope] = useState('deploy');
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created);
      setCopied(true);
    } catch {
      toast('Could not copy: select the token and copy it by hand', 'fail');
    }
  };
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const t = await post<{ token: string }>('/api/v1/tokens', {
        name,
        scopes: [scope],
        expiresInDays: 90,
      });
      setCreated(t.token);
      setCopied(false);
      setName('');
      await tokens.refetch();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed', 'fail');
    }
  };
  return (
    <Panel title="API tokens · for the CLI and CI">
      <form onSubmit={create} className="mb-4 flex flex-col gap-2 sm:flex-row">
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="laptop CLI"
          aria-label="Token name"
          className={`${input} flex-1`}
        />
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          aria-label="Scope"
          className={input}
        >
          <option value="read">read</option>
          <option value="deploy">deploy</option>
          <option value="admin">admin</option>
        </select>
        <Button type="submit" variant="primary">
          Create
        </Button>
      </form>
      {created && (
        <div className="mb-4 rounded-md border border-warn/40 bg-warn/10 p-3 text-[13px]">
          <p className="mb-2 text-warn">Copy it now — it will not be shown again.</p>
          <div className="flex items-start gap-2">
            <code className="block min-w-0 flex-1 break-all rounded bg-bg px-2 py-1.5 font-mono text-[12px] text-fg">
              {created}
            </code>
            <Button size="sm" onClick={copy} aria-label="Copy token">
              {copied ? 'Copied ✓' : 'Copy'}
            </Button>
          </div>
        </div>
      )}
      <ul className="divide-y divide-line">
        {tokens.data?.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-3 py-2.5 text-[13px]">
            <span className="flex-1">{t.name}</span>
            <span className="font-mono text-[12px] text-muted">
              {t.prefix}… · {t.scopes.join(', ')} · used{' '}
              {t.lastUsedAt ? ago(t.lastUsedAt) : 'never'}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await del(`/api/v1/tokens/${t.id}`);
                await tokens.refetch();
              }}
            >
              Revoke
            </Button>
          </li>
        ))}
        {tokens.data?.length === 0 && <li className="py-3 text-[13px] text-muted">No tokens.</li>}
      </ul>
    </Panel>
  );
}

function Webhooks() {
  const hooks = useWebhooks();
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['deployment.succeeded', 'deployment.failed']);
  const [secret, setSecret] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const deliveries = useDeliveries(selected);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const w = await post<{ id: string; secret: string }>('/api/v1/webhooks', { url, events });
      setSecret(w.secret);
      setUrl('');
      setSelected(w.id);
      await hooks.refetch();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed', 'fail');
    }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr] [&>*]:min-w-0">
      <Panel title="Endpoints">
        <form onSubmit={create} className="mb-4 flex flex-col gap-2">
          <input
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/hooks/autodeploy"
            aria-label="Endpoint URL"
            className={input}
          />
          <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
            <legend className="sr-only">Events</legend>
            {EVENTS.map((ev) => (
              <label
                key={ev}
                className="flex items-center gap-1.5 font-mono text-[11px] text-muted"
              >
                <input
                  type="checkbox"
                  checked={events.includes(ev)}
                  onChange={(e) =>
                    setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))
                  }
                  className="accent-[var(--color-run)]"
                />
                {ev}
              </label>
            ))}
          </fieldset>
          <Button type="submit" variant="primary" className="self-start">
            Add endpoint
          </Button>
        </form>
        {secret && (
          <p className="mb-3 rounded-md border border-warn/40 bg-warn/10 p-3 text-[12px] text-warn">
            Signing secret (shown once): <code className="break-all text-fg">{secret}</code>
          </p>
        )}
        <ul className="divide-y divide-line">
          {hooks.data?.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <button
                type="button"
                onClick={() => setSelected(h.id)}
                className={`min-w-0 flex-1 truncate text-left font-mono text-[12px] ${selected === h.id ? 'text-run' : 'text-fg'}`}
              >
                {h.url}
              </button>
              <Button
                size="sm"
                onClick={async () => {
                  await post(`/api/v1/webhooks/${h.id}/test`);
                  setSelected(h.id);
                  toast('Test ping queued', 'ok');
                }}
              >
                Ping
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  await del(`/api/v1/webhooks/${h.id}`);
                  await hooks.refetch();
                }}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Delivery log" pad={false}>
        {!selected ? (
          <p className="p-4 text-[13px] text-muted">Select an endpoint.</p>
        ) : (
          <ul className="divide-y divide-line">
            {deliveries.data?.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-4 py-2.5 font-mono text-[12px]">
                <span
                  className={
                    d.status === 'succeeded'
                      ? 'text-ok'
                      : d.status === 'pending'
                        ? 'text-run'
                        : 'text-fail'
                  }
                >
                  {d.status}
                </span>
                <span className="flex-1 truncate">{d.eventType}</span>
                <span className="text-muted">
                  {d.responseStatus ?? '—'} · {d.responseMs ?? '—'}ms · ×{d.attempts}
                </span>
                {d.status !== 'succeeded' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      await post(`/api/v1/webhooks/${selected}/deliveries/${d.id}/redeliver`);
                      toast('Redelivery queued', 'ok');
                    }}
                  >
                    Redeliver
                  </Button>
                )}
              </li>
            ))}
            {deliveries.data?.length === 0 && (
              <li className="px-4 py-3 text-[13px] text-muted">No deliveries yet.</li>
            )}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function Audit() {
  const audit = useAudit();
  return (
    <Panel title="Audit log" pad={false}>
      <ul className="divide-y divide-line font-mono text-[12px]">
        {audit.data?.items.map((e) => (
          <li key={e.id} className="grid grid-cols-[7rem_8rem_minmax(0,1fr)] gap-3 px-4 py-2">
            <span className="text-muted">{ago(e.createdAt)}</span>
            <span className="text-fg">{e.action}</span>
            <span className="truncate text-muted">
              {e.actor} {e.targetType && `→ ${e.targetType} ${e.targetId?.slice(0, 8)}`}{' '}
              {e.ip && `· ${e.ip}`}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
