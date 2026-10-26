# Notice

`LICENSE` is the MIT text and nothing else, so that GitHub, npm and catalog
crawlers can detect the licence without guessing. This file carries the two
things that would otherwise sit inside it: what `LICENSE` covers, and what it
does not.

## What the MIT licence covers

This project only — the plugin code in this repository and the package
published from it.

## What it does not cover

This project is a visualization and automation layer for GitNexus. It does not
fork GitNexus, does not modify it, and does not redistribute its source.
GitNexus is a separate project distributed under PolyForm-Noncommercial-1.0.0
and remains the property of its author, Abhigyan Patwari — see
<https://github.com/abhigyanpatwari/GitNexus>.

GitNexus is declared as a **peer**, not a dependency: installing this project
does not install GitNexus, and nothing under that licence ships inside this
package. But **your use of GitNexus through this project is subject to
GitNexus's licence**: noncommercial use is granted, commercial use requires a
separate grant from its author. The README has the same point in fewer words,
under "License (read before commercial use)".

## Enforced by a test

`test/suites/hygiene.mjs` checks that `LICENSE` still says MIT and that nothing
in it was appended after the standard text — a notice that drifts back into
`LICENSE` silently turns the detected licence into "Other" on every catalog
that reads GitHub.
