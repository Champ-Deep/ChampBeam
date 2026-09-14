"""Link rewriter unit tests: inventory, classification, surgical rewriting.

The rewriter is pure and byte-preserving: only matched href attribute values
change; a page with nothing to rewrite comes back byte-identical.
"""

from __future__ import annotations

from app.services import link_rewrite


def test_inventory_classifies():
    html = (
        '<a href="https://example.com">ext</a> '
        '<a href="/p/harshil-plan">page</a> '
        '<a href="/f/Ab12cd">file</a> '
        '<a href="Harshil Plan.html">sibling</a> '
        '<a href="#top">anchor</a> <a href="mailto:a@b.c">mail</a>'
    )
    rows = link_rewrite.link_inventory(html)
    kinds = [r["kind"] for r in rows]
    assert kinds == ["external", "platform-page", "platform-file", "internal", "fragment", "external"]


def test_inventory_anchor_text():
    html = '<a href="x.html" title="t">Click <b>here</b></a>'
    rows = link_rewrite.link_inventory(html)
    assert rows[0]["anchor_text"] == "Click here"


def test_external_and_fragment_never_touched():
    html = '<a href="https://x.com">a</a><a href="#top">b</a><a href="tel:%2B911">c</a>'
    out, report = link_rewrite.resolve_links(html, resolver={"x.com": "/p/x"})
    assert out == html
    assert report == []


def test_no_match_is_byte_identical_and_reported_unresolved():
    html = '<a href="index.html">Home</a>'
    out, report = link_rewrite.resolve_links(html, resolver={})
    assert out == html
    assert report == [{"from_href": "index.html", "to": None, "kind": "unresolved"}]


def test_sibling_file_mapped_with_query_and_fragment_kept():
    html = '<a href="Harshil Plan.html?src=nav#top">Plan</a>'
    out, report = link_rewrite.resolve_links(html, resolver={"harshil plan": "/p/harshil-plan"})
    assert '<a href="/p/harshil-plan?src=nav#top">Plan</a>' in out
    assert report[0]["kind"] == "mapped"


def test_platform_file_code_mapped():
    html = '<a href="/f/Ab12cd">Old link</a>'
    out, report = link_rewrite.resolve_links(html, resolver={"/f/Ab12cd": "/p/harshil-plan"})
    assert '<a href="/p/harshil-plan">Old link</a>' in out
    assert report[0]["kind"] == "platform"


def test_canonical_page_link_untouched():
    html = '<a href="/p/harshil-plan">Plan</a>'
    out, report = link_rewrite.resolve_links(html, resolver={}, slugs=["harshil-plan"])
    assert out == html
    assert report == []


def test_fuzzy_filename_to_slug():
    html = '<a href="Event Scout 2026 - Harshil Plan.html">Harshil\'s plan</a>'
    out, _ = link_rewrite.resolve_links(html, resolver={"harshil-plan": "/p/harshil-plan"}, slugs=["harshil-plan", "harsha-plan"])
    assert '<a href="/p/harshil-plan">' in out


def test_ambiguous_fuzzy_stays_unresolved():
    html = '<a href="Plan.html">Plan</a>'
    out, report = link_rewrite.resolve_links(html, resolver={}, slugs=["harshil-plan", "harsha-plan"])
    assert out == html
    assert report[0]["kind"] == "unresolved"


def test_route_overrides_everything():
    html = '<a href="https://example.com">ext</a>'
    out, report = link_rewrite.resolve_links(
        html, resolver={}, routes={"https://example.com": "/p/new-home"}
    )
    assert '<a href="/p/new-home">ext</a>' in out
    assert report[0]["kind"] == "routed"


def test_rest_of_document_is_byte_identical():
    html = (
        "<!doctype html><html><body>\n"
        '<p class="keep" data-x="1">Text with <em>markup</em> unchanged.</p>\n'
        '<a href="old.html" class="btn" data-id="7">Go</a>\n'
        "<script>const x = '<a href=\"fake.html\">';</script>\n"
        "</body></html>"
    )
    out, _ = link_rewrite.resolve_links(html, resolver={"old": "/p/old"})
    # The script tag content is not an <a ...> tag and must survive verbatim.
    assert "const x = '<a href=\"fake.html\">';" in out
    assert '<a href="/p/old" class="btn" data-id="7">Go</a>' in out
    assert out.replace('<a href="/p/old"', '<a href="old.html"') == html


def test_page_title_extraction():
    assert link_rewrite.page_title("<html><head><title>Event Scout Plan</title></head></html>") == "Event Scout Plan"
    assert link_rewrite.page_title("<title> A  <b>B</b> </title>") == "A B"
    assert link_rewrite.page_title("<html></html>") is None