import type { Metadata } from 'next';
import { Contact, LegalTitle } from '@/components/legal';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: 'Security · AutoDeploy' };

export default function Security() {
  return (
    <>
      <LegalTitle
        title="Security"
        intro="If you think you have found a security problem in AutoDeploy, please tell me privately first. Good-faith reports are welcome and will be taken seriously."
      />

      <h2>How to report</h2>
      <p>
        Email <Contact /> with what you found, the steps to reproduce it, and its impact. I aim to
        acknowledge reports within 3 days and to keep you updated until it is fixed.
      </p>

      <h2>In scope</h2>
      <ul>
        <li>the dashboard ({LEGAL.appUrl.replace('https://', '')}) and the API;</li>
        <li>the edge that serves sites under {LEGAL.siteDomain};</li>
        <li>
          the build sandbox and server-rendered app runtime, including any way to reach another
          user&rsquo;s data, secrets or sites.
        </li>
      </ul>
      <p>
        Problems in a site someone deployed on AutoDeploy belong to that site&rsquo;s owner; report
        those to them. Problems in third-party providers belong to those providers.
      </p>

      <h2>Rules for testing</h2>
      <ul>
        <li>Test only with your own account and projects.</li>
        <li>Don&rsquo;t access, change or keep other people&rsquo;s data.</li>
        <li>No denial of service, spam, social engineering or physical attacks.</li>
        <li>Give me a reasonable time to fix the issue (up to 90 days) before disclosing it.</li>
      </ul>
      <p>
        If you follow these rules, I won&rsquo;t pursue legal action over your research. AutoDeploy
        is a free project, so there is no paid bug bounty, but I will gladly credit you.
      </p>
    </>
  );
}
