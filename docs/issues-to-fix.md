# Issues to fix

Small things noticed while using the product; newest last.

- [x] **Colour wipe looks empty on phones.** Fixed 2026-10-18: a band with the wordmark on phones. Between the story and the numbers
  the landing page shows a full-screen cyan panel with the logo (the transition
  from the Relay reference). It works as a quick sweep on desktop, but on a
  phone it reads as a large empty block. Proposed: a thin band with the logo on
  small screens, full sweep on desktop. (`apps/web/components/landing/sections/Wipe.tsx`)
  import env keys for deployment projects if a env file is given or give option to manually add from the user.
