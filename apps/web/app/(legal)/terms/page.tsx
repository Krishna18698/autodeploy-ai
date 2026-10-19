import type { Metadata } from 'next';
import Link from 'next/link';
import { Contact, LegalTitle } from '@/components/legal';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: 'Terms of Service · AutoDeploy' };

export default function Terms() {
  return (
    <>
      <LegalTitle
        title="Terms of Service"
        intro={
          <>
            These terms are an agreement between you and {LEGAL.operator}, an individual based in{' '}
            {LEGAL.place}, who runs AutoDeploy (&ldquo;I&rdquo;, &ldquo;me&rdquo;). By creating an
            account or using the service you accept them, the{' '}
            <Link href="/privacy">Privacy Policy</Link> and the{' '}
            <Link href="/acceptable-use">Acceptable Use Policy</Link>.
          </>
        }
      />

      <h2>1. Who can use it</h2>
      <p>
        You must be at least 18 and able to enter a binding contract. If you use AutoDeploy for an
        organisation, you confirm you may accept these terms on its behalf.
      </p>

      <h2>2. The service</h2>
      <p>
        AutoDeploy builds static sites and server-rendered apps from your GitHub repositories, hosts
        them at addresses under {LEGAL.siteDomain}, and suggests repairs when a build fails. It is
        free and in open beta: features can change, and the service may be paused or discontinued.
        If paid plans are ever introduced they will come with their own terms and notice; nothing
        you have now will start costing money without your agreement.
      </p>

      <h2>3. Limits</h2>
      <p>
        The service runs on shared free infrastructure, so each account has limits, currently: 10
        projects (3 of them server-rendered), 20 deployments a day, 300 build minutes a month, 1 GB
        of stored builds and 60 AI repair requests a day. Server-rendered apps sleep after 15
        minutes without visitors and wake on the next request. Your usage is shown in Settings →
        Usage. Limits may change. Don&rsquo;t create extra accounts to get around them.
      </p>

      <h2>4. Your account</h2>
      <p>
        Keep your sign-in and API tokens safe; you are responsible for what is done with them. Tell
        me promptly at <Contact /> if you think your account has been misused.
      </p>

      <h2>5. Your content</h2>
      <p>
        Your code, sites and data stay yours. You give me a limited permission to copy, build, store
        and serve them only as needed to run the service, including sending build-log excerpts and
        related files to AI providers when AI repair is on (see the Privacy Policy). You confirm you
        have the rights to everything you deploy and that it follows the law and the Acceptable Use
        Policy. You are responsible for your sites, including their own privacy notices and the
        claims that arise from them.
      </p>

      <h2>6. Automatic and AI repairs</h2>
      <p>
        Rule-based fixes only change how a build runs (for example the Node version or install
        flags), never your code. AI-suggested changes to code are never applied to your repository
        without your approval, as an approved deployment or a pull request. Suggestions can be
        wrong; review them before approving.
      </p>

      <h2>7. Availability and your data</h2>
      <p>
        The service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without an
        uptime commitment. Keep your repository as the source of truth; stored builds and logs can
        be pruned or lost.
      </p>

      <h2>8. Suspension and ending</h2>
      <p>
        You can delete your account at any time in Settings → Account. I may remove a site or
        suspend an account that breaks these terms or the Acceptable Use Policy, puts the service or
        others at risk, or where the law requires it. Where it is safe and lawful I will tell you
        first and give you a chance to fix things. If I shut the service down I will give at least
        30 days&rsquo; notice by email (if you have set one) and on this site.
      </p>

      <h2>9. Liability</h2>
      <p>
        To the extent the law allows, I give no warranties, and I am not liable for indirect or
        consequential losses, lost profits or lost data. Because the service is free, my total
        liability to you for any claim is limited to ₹1,000. Nothing here limits liability that
        cannot be limited under Indian law.
      </p>

      <h2>10. Law and disputes</h2>
      <p>
        These terms are governed by the laws of India. The courts at {LEGAL.courts} have exclusive
        jurisdiction. Before going to court, please write to me so we can try to resolve it.
      </p>

      <h2>11. Changes</h2>
      <p>
        I may update these terms. Changes are posted here with a new effective date, and significant
        ones are also emailed if you have set a notification email. Continuing to use the service
        after a change means you accept it.
      </p>

      <h2>12. Contact</h2>
      <p>
        {LEGAL.operator}, {LEGAL.place}. Email: <Contact />.
      </p>
    </>
  );
}
