// Who runs the service and how to reach them, shared by the legal pages,
// the footer and /.well-known/security.txt.

export const LEGAL = {
  operator: 'Krishna Shravan',
  place: 'Karnataka, India',
  courts: 'Bengaluru, Karnataka',
  /** Public contact and grievance address; filled in before the pages go live. */
  email: '',
  effective: '19 October 2026',
  appUrl: 'https://app.autodeploy.dpdns.org',
  siteDomain: 'autodeploy.dpdns.org',
} as const;

export const LEGAL_PAGES = [
  ['Terms of Service', '/terms'],
  ['Privacy Policy', '/privacy'],
  ['Acceptable Use', '/acceptable-use'],
  ['Security', '/security'],
] as const;
