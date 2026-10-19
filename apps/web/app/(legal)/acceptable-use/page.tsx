import type { Metadata } from 'next';
import Link from 'next/link';
import { Contact, LegalTitle } from '@/components/legal';

export const metadata: Metadata = { title: 'Acceptable Use Policy · AutoDeploy' };

export default function AcceptableUse() {
  return (
    <>
      <LegalTitle
        title="Acceptable Use Policy"
        intro={
          <>
            AutoDeploy is shared, free infrastructure. This policy, part of the{' '}
            <Link href="/terms">Terms of Service</Link>, lists what it may not be used for, so that
            it stays safe and available for everyone.
          </>
        }
      />

      <h2>Don&rsquo;t build or host</h2>
      <ul>
        <li>
          malware, phishing, credential harvesting, or sites that pretend to be another person,
          brand or organisation;
        </li>
        <li>
          anything illegal in India or where you are, including child sexual abuse material,
          terrorist content, and content that infringes copyright, trademarks or privacy;
        </li>
        <li>spam, scams, fraud, or misleading financial schemes;</li>
        <li>harassment, threats, or content that promotes violence or hatred against people.</li>
      </ul>

      <h2>Don&rsquo;t use the resources for</h2>
      <ul>
        <li>cryptocurrency mining or other general-purpose computing in builds or apps;</li>
        <li>proxies, VPNs, open relays, or file-sharing and media-streaming services;</li>
        <li>attacking, scanning or load-testing other systems;</li>
        <li>sending bulk or unsolicited email or messages.</li>
      </ul>

      <h2>Don&rsquo;t try to</h2>
      <ul>
        <li>get around per-account limits, for example with several accounts or automation;</li>
        <li>access other users&rsquo; data, projects or sites;</li>
        <li>
          break out of the build sandbox, or probe or disrupt the service, except for good-faith
          security research that follows the <Link href="/security">Security</Link> page.
        </li>
      </ul>

      <h2>What happens if this is broken</h2>
      <p>
        I may take a site offline, stop its builds, or suspend the account. Where there is a risk of
        harm to others I may act first and explain after; otherwise I will contact you first. I also
        act on valid complaints and legal orders as required by Indian law, including the
        Information Technology Act, 2000 and the rules under it.
      </p>

      <h2>Report abuse</h2>
      <p>
        Email <Contact /> with the site address and what is wrong. I aim to acknowledge reports
        within 24 hours and act on them within 72 hours.
      </p>
    </>
  );
}
