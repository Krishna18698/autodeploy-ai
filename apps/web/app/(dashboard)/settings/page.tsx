'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/app/shell';
import { Button } from '@/components/ui/button';
import { Panel, SkeletonItems, SkeletonRows } from '@/components/ui/panel';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { ApiError, apiUrl, del, patch, post } from '@/lib/api';
import { ago } from '@/lib/format';
import {
  useAudit,
  useDeliveries,
  useMe,
  useMembers,
  usePendingInvites,
  useQuota,
  useTokens,
  useTwoFactor,
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
  const toast = useToast();
  // Links land on a tab (?tab=account); coming back from GitHub says how linking went.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get('tab');
    if (t && ['team', 'account', 'usage', 'tokens', 'webhooks', 'audit'].includes(t))
      setTab(t as TabId);
    const gh = q.get('github');
    if (gh === 'connected') toast('GitHub connected', 'ok');
    if (gh === 'taken')
      toast('That GitHub account is already linked to another AutoDeploy account', 'fail');
    // Shown once: a refresh shouldn't repeat it.
    if (gh) window.history.replaceState(null, '', `/settings${t ? `?tab=${t}` : ''}`);
  }, [toast]);
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
            <TwoFactor />
            <GitHubLink />
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

function GitHubLink() {
  const me = useMe();
  if (!me.data) return null;
  const connected = me.data.user.githubConnected;
  return (
    <Panel title="GitHub">
      {connected ? (
        <p className="text-[13px] text-muted">
          Connected. The AutoDeploy app can deploy the repositories you give it access to, and
          pushes deploy automatically.
        </p>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] text-muted">
            Connect your GitHub account to deploy private repositories and deploy on every push.
            Public repositories work without it.
          </p>
          <a
            href={apiUrl('/auth/github/connect')}
            className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-fg px-3.5 text-[13px] font-medium text-bg hover:bg-fg/90 pointer-coarse:h-10"
          >
            Connect GitHub
          </a>
        </div>
      )}
    </Panel>
  );
}

function Team({ canEdit }: { canEdit: boolean }) {
  const members = useMembers();
  const invites = usePendingInvites(canEdit);
  const toast = useToast();
  const [login, setLogin] = useState('');
  const [role, setRole] = useState('member');
  // Adding someone invites them; they join when they accept.
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post('/api/v1/members', { login, role });
      setLogin('');
      toast(`Invitation sent. ${login} joins when they accept.`, 'ok');
      await invites.refetch();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Failed', 'fail');
    }
  };
  const cancelInvite = async (id: string) => {
    try {
      await del(`/api/v1/members/invitations/${id}`);
      await invites.refetch();
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
            placeholder="Username"
            aria-label="Username to invite"
            className={`${input} sm:flex-1`}
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
            Invite
          </Button>
        </form>
      )}
      <ul className="divide-y divide-line">
        {!members.data && <SkeletonItems rows={3} />}
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
      {canEdit && invites.data && invites.data.length > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-[12px] text-muted">Invited, not joined yet</h3>
          <ul className="divide-y divide-line">
            {invites.data.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2.5 text-[13px]">
                <span className="flex-1">
                  {i.login} <span className="text-muted">as {i.role}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => cancelInvite(i.id)}>
                  Cancel
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
          className={`${input} sm:flex-1`}
        />
        <Button type="submit" variant="primary" loading={saving} disabled={value === current}>
          Save
        </Button>
      </form>
    </Panel>
  );
}

/** Deletes the account and every org it alone owns; typed confirmation, sessions only. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const toast = useToast();
  const text = `AutoDeploy recovery codes (each works once)\n\n${codes.join('\n')}\n`;
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'autodeploy-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div>
      <p className="mb-3 text-[13px] text-muted">
        Save these somewhere safe, like a password manager. If you lose your phone, each one signs
        you in once. They won’t be shown again.
      </p>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg border border-line bg-bg p-4 font-mono text-[13px] sm:grid-cols-5">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() =>
            navigator.clipboard.writeText(text).then(
              () => toast('Copied', 'ok'),
              () => {},
            )
          }
        >
          Copy
        </Button>
        <Button size="sm" onClick={download}>
          Download
        </Button>
        <Button size="sm" variant="primary" onClick={onDone}>
          I’ve saved them
        </Button>
      </div>
    </div>
  );
}

// Two-step sign-in: an authenticator app's code at sign-in and before risky changes.
function TwoFactor() {
  const status = useTwoFactor();
  const toast = useToast();
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [turningOff, setTurningOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const fail = (err: unknown) => toast(err instanceof ApiError ? err.message : 'Failed', 'fail');
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    run(async () => {
      setSetup(await post<{ secret: string; qrSvg: string }>('/api/v1/me/2fa/setup'));
      setCode('');
    });
  const turnOn = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      const r = await post<{ recoveryCodes: string[] }>('/api/v1/me/2fa/enable', { code });
      setSetup(null);
      setCode('');
      setCodes(r.recoveryCodes);
    });
  };
  const turnOff = (e: React.FormEvent) => {
    e.preventDefault();
    return run(async () => {
      await del('/api/v1/me/2fa', { code });
      setTurningOff(false);
      setCode('');
      toast('Two-step sign-in is off', 'ok');
      await status.refetch();
    });
  };
  const newCodes = () =>
    run(async () => {
      setCodes(
        (await post<{ recoveryCodes: string[] }>('/api/v1/me/2fa/recovery-codes')).recoveryCodes,
      );
    });

  const codeInput = (
    <input
      value={code}
      onChange={(e) => setCode(e.target.value)}
      placeholder="6-digit code"
      aria-label="Code from your authenticator app"
      autoComplete="one-time-code"
      inputMode="numeric"
      className={`${input} sm:w-40`}
    />
  );

  return (
    <Panel title="Two-step sign-in">
      {codes ? (
        <RecoveryCodes
          codes={codes}
          onDone={() => {
            setCodes(null);
            void status.refetch();
          }}
        />
      ) : setup ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          {/* biome-ignore lint/performance/noImgElement: a data URL made by the API; next/image adds nothing */}
          <img
            src={setup.qrSvg}
            alt="QR code to scan with your authenticator app"
            width={168}
            height={168}
            className="shrink-0 rounded-lg bg-white p-1"
          />
          <div className="min-w-0 flex-1 text-[13px]">
            <p className="text-muted">
              Scan this with your authenticator app (Google Authenticator, Microsoft Authenticator,
              1Password…), then enter the code it shows.
            </p>
            <p className="mt-3 text-muted">Can’t scan? Type this key into the app instead:</p>
            <p className="mt-1 break-all font-mono text-[13px] text-fg">
              {setup.secret.match(/.{1,4}/g)?.join(' ')}
            </p>
            <form onSubmit={turnOn} className="mt-4 flex flex-col gap-2 sm:flex-row">
              {codeInput}
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                disabled={code.trim().length < 6}
              >
                Turn on
              </Button>
              <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </form>
          </div>
        </div>
      ) : status.data?.enabled ? (
        <div className="text-[13px]">
          <p>
            <span className="text-ok">● On.</span>{' '}
            <span className="text-muted">
              Signing in and risky changes ask for a code. {status.data.recoveryCodesLeft} recovery
              codes left.
            </span>
          </p>
          {turningOff ? (
            <form onSubmit={turnOff} className="mt-3 flex flex-col gap-2 sm:flex-row">
              {codeInput}
              <Button
                type="submit"
                variant="danger"
                loading={busy}
                disabled={code.trim().length < 6}
              >
                Turn off
              </Button>
              <Button type="button" variant="ghost" onClick={() => setTurningOff(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={newCodes} loading={busy}>
                New recovery codes
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setTurningOff(true)}>
                Turn off
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-[13px] sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted">
            Ask for a code from an authenticator app when you sign in and before risky changes, so a
            stolen password alone isn’t enough.
          </p>
          <Button onClick={start} loading={busy} className="shrink-0">
            Set up
          </Button>
        </div>
      )}
    </Panel>
  );
}

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
          className={`${input} sm:flex-1`}
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
  if (!q.data)
    return (
      <Panel title="Usage" pad={false}>
        <SkeletonRows rows={5} className="h-7" />
      </Panel>
    );
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
          className={`${input} sm:flex-1`}
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
        {!tokens.data && <SkeletonItems rows={2} />}
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
          {!hooks.data && <SkeletonItems rows={2} />}
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
            {!deliveries.data && <SkeletonItems rows={3} className="h-5" />}
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
        {!audit.data && <SkeletonItems rows={6} className="h-4" />}
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
