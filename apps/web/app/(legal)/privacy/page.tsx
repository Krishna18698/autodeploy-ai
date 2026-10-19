import type { Metadata } from 'next';
import Link from 'next/link';
import { Contact, LegalTitle } from '@/components/legal';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: 'Privacy Policy · AutoDeploy' };

export default function Privacy() {
  return (
    <>
      <LegalTitle
        title="Privacy Policy"
        intro={
          <>
            AutoDeploy ({LEGAL.appUrl.replace('https://', '')} and sites under {LEGAL.siteDomain})
            is run by {LEGAL.operator}, an individual based in {LEGAL.place} (&ldquo;I&rdquo;,
            &ldquo;me&rdquo;). This policy explains what personal data the service handles, why, who
            else processes it, and the rights you have under India&rsquo;s Digital Personal Data
            Protection Act, 2023.
          </>
        }
      />

      <h2>1. What I collect</h2>
      <ul>
        <li>
          <strong>Your account.</strong> When you sign in with GitHub: your GitHub user ID, login,
          display name and avatar address. Your email address only if you enter one for
          notifications.
        </li>
        <li>
          <strong>Sign-in sessions.</strong> The IP address and browser type each session was
          created from, kept until the session expires (14 days after you last use it).
        </li>
        <li>
          <strong>Your projects.</strong> Repository addresses, build settings, environment
          variables (encrypted with AES-256-GCM and decrypted only inside your build), deployment
          history, build logs, the built files of your site, screenshots taken while checking a
          deployment, and an audit log of changes (including the IP address each change came from).
        </li>
        <li>
          <strong>Your source code.</strong> Fetched from GitHub for each build into an isolated
          sandbox and discarded when the build ends. Only the built output is kept, to serve your
          site.
        </li>
        <li>
          <strong>Errors and performance.</strong> When the dashboard or the server hits an error, a
          report (the error, the page address and your browser type) is sent to Sentry. Operational
          metrics and traces go to Grafana Cloud. These never include environment variable values or
          your source code.
        </li>
        <li>
          <strong>Visitors to sites you deploy.</strong> Requests pass through Cloudflare and
          AutoDeploy&rsquo;s edge. For server-rendered apps, the visitor&rsquo;s IP address is
          passed on to your app. I don&rsquo;t profile visitors or add analytics to your site; you
          are responsible for your own site&rsquo;s privacy notice.
        </li>
        <li>
          <strong>Cookies.</strong> One sign-in cookie and a token that protects forms against
          cross-site requests. No advertising or analytics cookies.
        </li>
      </ul>

      <h2>2. How it is used</h2>
      <p>
        Only to run the service: signing you in, building and hosting your sites, sending the
        notifications you asked for, keeping the service secure (rate limits, abuse prevention,
        per-account limits) and fixing problems. Your data is not sold, not used for advertising,
        and not used by me to train AI models.
      </p>

      <h2>3. AI repair</h2>
      <p>
        When a build fails and AI repair is on for the project, an excerpt of the build log and the
        source files it points to are sent to AI providers to suggest a fix: <strong>NVIDIA</strong>{' '}
        (build.nvidia.com) first, <strong>OpenRouter</strong> as a fallback, and{' '}
        <strong>Cloudflare Workers AI</strong> to classify the error. Known secrets and environment
        variable values are masked in logs before anything is stored or sent. These are free tiers,
        and the providers may keep inputs under their own terms. AI repair is on by default; switch
        it off per project in its Build settings if you don&rsquo;t want its code shared. A
        suggested fix is never applied to your repository without your approval.
      </p>

      <h2>4. Who processes data for me</h2>
      <ul>
        <li>Oracle Cloud: servers and database (Mumbai, India)</li>
        <li>Cloudflare: network, edge serving of sites, Workers AI (worldwide)</li>
        <li>Vercel: hosting for this dashboard (worldwide)</li>
        <li>Backblaze B2: built sites, logs, screenshots and encrypted backups (USA)</li>
        <li>GitHub: sign-in and fetching your repositories (USA)</li>
        <li>Resend: notification emails (USA)</li>
        <li>Sentry: error reports (USA)</li>
        <li>Grafana Cloud: metrics and traces (Mumbai, India)</li>
        <li>NVIDIA and OpenRouter: AI repair, as described above (USA)</li>
      </ul>
      <p>
        Some of these store data outside India; the Act permits this except to countries the
        Government of India restricts.
      </p>

      <h2>5. How long it is kept</h2>
      <ul>
        <li>Account and project data: until you delete the project or your account.</li>
        <li>Sessions: 14 days after last use.</li>
        <li>
          Older deployments: each project keeps its latest deployments and the live one; files of
          older ones are deleted automatically.
        </li>
        <li>
          After you delete your account (Settings → Account): database records at once, stored
          builds and logs within a day, encrypted backups within 4 weeks.
        </li>
      </ul>

      <h2>6. Your rights</h2>
      <p>Under the Digital Personal Data Protection Act, 2023 you can:</p>
      <ul>
        <li>ask for a summary of the personal data held about you and how it is processed;</li>
        <li>correct or update it (your notification email is editable in Settings);</li>
        <li>erase it: delete your account in Settings → Account, or ask me to;</li>
        <li>withdraw consent, by deleting your account;</li>
        <li>nominate someone to exercise these rights if you die or become unable to;</li>
        <li>raise a grievance with me, and then with the Data Protection Board of India.</li>
      </ul>
      <p>
        Write to <Contact />. I aim to reply within 7 days and resolve requests within 30 days.
      </p>

      <h2>7. Security</h2>
      <p>
        Traffic is encrypted with HTTPS, environment variables are encrypted at rest, builds run in
        a gVisor sandbox with limited network access, and backups are encrypted. No system is
        perfectly secure; if a breach affects your data I will tell you and the Data Protection
        Board as the law requires. To report a vulnerability, see{' '}
        <Link href="/security">Security</Link>.
      </p>

      <h2>8. Children</h2>
      <p>
        AutoDeploy is for people aged 18 and over. Please don&rsquo;t use it if you are younger.
      </p>

      <h2>9. Changes</h2>
      <p>
        Changes are posted on this page with a new effective date. For significant changes I will
        also email you if you have set a notification email.
      </p>

      <h2>10. Contact and grievance officer</h2>
      <p>
        {LEGAL.operator}, {LEGAL.place}. Email: <Contact />.
      </p>
    </>
  );
}
