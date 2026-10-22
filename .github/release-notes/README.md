# Release headers

A file named after the tag (`v0.3.0.md`, `v0.3.0-rc.1.md`) is put at the top of
that GitHub release, above the generated change list and the image block. It is
the part a person writes: what the release is about, what breaks, how to update
the panel and the node agents.

No file for a tag: the release goes out with the generated list alone.

The release is built from the tagged commit, so the file is committed before
the tag is pushed. A later edit on a branch does not reach a release that
already exists: change that one by hand on GitHub.
