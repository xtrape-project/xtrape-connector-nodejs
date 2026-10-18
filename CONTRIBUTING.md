# Contributing

## What is open right now

**This phase (`0.7.x`) accepts Issues, not code.** Open public Issues in the
`xtrape-com` GitHub organization. Internal Forgejo access is not required, and
is not available.

External pull requests are **not** accepted yet. Canonical development happens
on a private Forgejo instance, and these GitHub repositories are one-way
read-only mirrors — a pull request opened here cannot be merged, because the
next mirror push would overwrite it. That is a deliberate staging decision, and
it is stated plainly so nobody spends a weekend on a change that cannot be
taken.

If you have a fix you want to contribute now, open an Issue describing it and
attach a patch (`git format-patch`) or link a branch on your fork. A maintainer
can apply it internally with your authorship and DCO sign-off preserved. It is
slower than a pull request; it exists so a real contribution is not simply
refused.

**From `0.8.0` this changes** — public repositories become canonical on GitHub
and pull requests become the normal path.

## Standards

Xtrape uses **Developer Certificate of Origin 1.1** sign-off (`git commit -s`).
Report what you actually tested, and disclose material AI assistance.

The legacy policy links have retired. For the current public contribution and support entry, see [SUPPORT.md](SUPPORT.md).
