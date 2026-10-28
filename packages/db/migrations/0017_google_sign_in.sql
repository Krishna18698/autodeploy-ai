-- Sign in with Google: Google's permanent ID for the person ("sub"), not their
-- email (emails change, and an address can be recycled to someone else).
alter table users add column google_sub text unique;
